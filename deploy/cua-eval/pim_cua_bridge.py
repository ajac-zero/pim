#!/usr/bin/env python3
"""pim-cua-bridge: the few calls a Pim's Cua evaluation provider makes, on one Cua machine.

A private evaluation prototype, not a product (see docs/cua-evaluation.md). It runs on the Cua
VM, bound to loopback, behind the VM's Caddy, which proxies exactly /pim-bridge/v1/{status,call,
driver,viewer} to it. It is the only holder of cua-spacesd's root token besides spacesd itself:
Pim sends its own machine credential, never the root token, and the root token never leaves the
VM. Every call goes to the one spacesd on this machine at 127.0.0.1:3211, which is fixed: no call
names a URL, a host or a spacesd method.

- `status`: whether spacesd answers, and how many agent calls are under way here.
- `call`: one of pim-computer's file and command calls (computer/pim-computer.ts's `handle`):
  stat, read, write, mkdir, rm, rename, readdir, find, grep, exec. Each runs as one process that
  spacesd starts as PIM_BRIDGE_RUN_AS (never root), which checks its paths against
  PIM_BRIDGE_ROOT after following links, as pim-computer does.
- `driver`: one of eight cua-driver tools for the browser over spacesd's /mcp, with fixed shapes: one
  driver session (`pim`), an isolated named profile (`pim`), never an existing profile.
- `viewer`: a short-lived viewer ticket (SystemService.CreateViewerTicket) for the person, refused
  while any agent call is under way here.

Only Python 3's standard library. Settings come from the environment (pim-cua-bridge.env.example);
the root token from the spacesd env file systemd hands over as a credential. It refuses to start
without a sound credential digest, a non-root user, a workspace root and the root token, and on
anything but a loopback address.
"""

import base64
import hashlib
import hmac
import http.client
import http.server
import ipaddress
import json
import os
import re
import signal
import sys
import threading
import time

VERSION = "0.1.0"
#: The one spacesd this bridge reaches. Not configurable.
SPACESD = ("127.0.0.1", 3211)
PREFIX = "/pim-bridge/v1/"
ROUTES = ("status", "call", "driver", "viewer")
#: The largest request: a 64 KiB write is 88 KiB of base64.
MAX_BODY = 192 * 1024
#: Header Pim sends its credential in, apart from any HTTP Basic login on the same host.
AUTH_HEADER = "X-Pim-Bridge-Authorization"
#: The one cua-driver session and isolated profile Pim's browser uses.
SESSION = "pim"
WORKSPACE = "/workspace"
MAX_READ = 1_048_576
MAX_WRITE_BASE64 = 96 * 1024
MAX_COMMAND_MS = 600_000
MAX_OUTPUT = 64_000
#: Agent calls at once; more are refused, not queued.
MAX_INFLIGHT = 4
#: Requests per window, and authentication failures per window before every request is refused for one.
RATE = (60, 10.0)
AUTH_FAILURES = (10, 60.0)
VIEWER_TTL_SECONDS = 300
HELPER_FAILED = 213


class Refusal(Exception):
    """A request the bridge refuses, with the status and a message safe to send back."""

    def __init__(self, status, message, code=None):
        super().__init__(message)
        self.status = status
        self.code = code


# ── Configuration ──────────────────────────────────────────────────────────────────────────────


def read_env_file(path):
    values = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values[key.strip().removeprefix("export ").strip()] = value
    return values


def load_config(environ):
    """The bridge's settings, or SystemExit naming what's wrong (never a secret's value)."""
    problems = []
    listen = environ.get("PIM_BRIDGE_LISTEN", "127.0.0.1:3290")
    host, _, port = listen.rpartition(":")
    try:
        if not ipaddress.ip_address(host.strip("[]")).is_loopback:
            problems.append("PIM_BRIDGE_LISTEN must be a loopback address: Caddy is its only client")
        port = int(port)
    except ValueError:
        problems.append("PIM_BRIDGE_LISTEN must be host:port, such as 127.0.0.1:3290")
    digest = environ.get("PIM_BRIDGE_TOKEN_SHA256", "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        problems.append("PIM_BRIDGE_TOKEN_SHA256 must be the SHA-256 (64 hex digits) of Pim's bridge credential")
    run_as = environ.get("PIM_BRIDGE_RUN_AS", "").strip()
    if not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", run_as) or run_as == "root":
        problems.append("PIM_BRIDGE_RUN_AS must name the desktop user, not root")
    root = environ.get("PIM_BRIDGE_ROOT", "").rstrip("/")
    if not root.startswith("/") or root.count("/") < 2 or "\0" in root or "/.." in root:
        problems.append("PIM_BRIDGE_ROOT must be an absolute folder at least two levels deep, such as /home/cua/pim")
    token = ""
    env_file = environ.get("PIM_BRIDGE_SPACESD_ENV") or os.path.join(environ.get("CREDENTIALS_DIRECTORY", "/nonexistent"), "spacesd.env")
    try:
        token = read_env_file(env_file).get("CUA_ENV_TOKEN", "")
    except OSError:
        problems.append("the spacesd env file isn't readable: set LoadCredential=spacesd.env:/etc/cua/spacesd.env")
    if token and len(token) < 16:
        problems.append("CUA_ENV_TOKEN in the spacesd env file is too short to be spacesd's root token")
    elif not token and not problems:
        problems.append("the spacesd env file has no CUA_ENV_TOKEN")
    if problems:
        raise SystemExit("pim-cua-bridge won't start: " + "; ".join(problems))
    return {
        "host": host.strip("[]"),
        "port": port,
        "digest": bytes.fromhex(digest),
        "run_as": run_as,
        "root": root,
        "token": token,
        "python": environ.get("PIM_BRIDGE_PYTHON", "/usr/bin/python3"),
    }


# ── Protocol buffers, as much as these calls need ─────────────────────────────────────────────


def varint(value):
    if value < 0:
        value += 1 << 64
    out = bytearray()
    while True:
        low = value & 0x7F
        value >>= 7
        if value:
            out.append(low | 0x80)
        else:
            out.append(low)
            return bytes(out)


def field_varint(number, value):
    return varint(number << 3) + varint(value) if value else b""


def field_bytes(number, value):
    return varint(number << 3 | 2) + varint(len(value)) + value


def field_string(number, value):
    return field_bytes(number, value.encode("utf-8")) if value else b""


def parse(buffer):
    """A message's fields: number → [value], each an int (varint, fixed) or bytes (length-delimited)."""
    fields = {}
    index = 0

    def read_varint():
        nonlocal index
        shift = result = 0
        while True:
            if index >= len(buffer) or shift > 63:
                raise ValueError("truncated varint")
            byte = buffer[index]
            index += 1
            result |= (byte & 0x7F) << shift
            if not byte & 0x80:
                return result
            shift += 7

    while index < len(buffer):
        key = read_varint()
        number, wire = key >> 3, key & 7
        if wire == 0:
            value = read_varint()
        elif wire == 2:
            length = read_varint()
            value = bytes(buffer[index : index + length])
            if len(value) != length:
                raise ValueError("truncated field")
            index += length
        elif wire in (1, 5):
            size = 8 if wire == 1 else 4
            value = int.from_bytes(buffer[index : index + size], "little")
            index += size
        else:
            raise ValueError("unsupported wire type")
        fields.setdefault(number, []).append(value)
    return fields


def last(fields, number, default=None):
    values = fields.get(number)
    return values[-1] if values else default


def int32(value):
    value &= (1 << 64) - 1
    return value - (1 << 64) if value >= 1 << 63 else value


def start_process_request(config, args, env, timeout_seconds):
    """StartProcessRequest (process.proto): `python3 -I -c HELPER` as the desktop user, killed with this request."""
    environment = b"".join(field_bytes(3, field_string(1, key) + field_string(2, value)) for key, value in env.items())
    process = (
        field_string(1, config["python"])
        + b"".join(field_string(2, arg) for arg in args)
        + environment
        + field_string(4, "/")
        + field_string(5, config["run_as"])
        + field_bytes(6, field_varint(1, timeout_seconds))
    )
    # config, keepalive_interval (15 s), scrollback_bytes (4 MiB), kill_on_disconnect.
    return field_bytes(1, process) + field_bytes(5, field_varint(1, 15)) + field_varint(6, 4 << 20) + field_varint(7, 1)


def viewer_ticket_request():
    """CreateViewerTicketRequest (system.proto): five minutes, interactive, no clipboard, no files, the person as a human."""
    principal = field_string(1, "pim-owner") + field_string(2, "Pim owner") + field_varint(4, 1)
    return field_bytes(1, field_varint(1, VIEWER_TTL_SECONDS)) + field_varint(2, 3) + field_bytes(6, principal)


# ── spacesd ─────────────────────────────────────────────────────────────────────────────────────


class Spacesd:
    """gRPC-Web and /mcp on the one local spacesd, with the root token. Failures never carry the token or a response body."""

    def __init__(self, token, address=SPACESD):
        self.token = token
        self.address = address
        self.mcp_session = None
        self.mcp_lock = threading.Lock()

    def connection(self, timeout):
        return http.client.HTTPConnection(*self.address, timeout=timeout)

    def health(self):
        try:
            connection = self.connection(5)
            connection.request("GET", "/health")
            healthy = connection.getresponse().status in (200, 204)
            connection.close()
            return healthy
        except OSError:
            return False

    def grpc(self, method, message, timeout):
        """Calls `method` (`cua.env.v1.Service/Method`) and yields each response message, then checks the trailers."""
        connection = self.connection(timeout)
        try:
            connection.request(
                "POST",
                "/" + method,
                body=b"\0" + len(message).to_bytes(4, "big") + message,
                headers={
                    "content-type": "application/grpc-web+proto",
                    "accept": "application/grpc-web+proto",
                    "x-grpc-web": "1",
                    "x-cua-env-authorization": "Bearer " + self.token,
                },
            )
            response = connection.getresponse()
            if response.status != 200:
                raise Refusal(502, "The Cua computer refused the call (HTTP %d)." % response.status)
            status = response.getheader("grpc-status")
            if status not in (None, "0"):
                raise Refusal(502, grpc_failure(status))
            trailers = None
            while True:
                head = response.read(5)
                if not head:
                    break
                if len(head) < 5:
                    raise Refusal(502, "The Cua computer's answer was cut short.")
                length = int.from_bytes(head[1:5], "big")
                if length > 8 << 20:
                    raise Refusal(502, "The Cua computer's answer was too large.")
                body = response.read(length)
                if len(body) != length:
                    raise Refusal(502, "The Cua computer's answer was cut short.")
                if head[0] & 0x80:
                    trailers = body.decode("latin-1")
                    break
                yield body
            status = re.search(r"(?im)^grpc-status:\s*(\d+)", trailers or "")
            if status and status.group(1) != "0":
                raise Refusal(502, grpc_failure(status.group(1)))
        except OSError:
            raise Refusal(502, "The Cua computer didn't answer.") from None
        finally:
            connection.close()

    def mcp(self, request, timeout):
        """One JSON-RPC request to /mcp in the bridge's driver session; opens an MCP session first if there is none."""
        with self.mcp_lock:
            for attempt in range(2):
                if self.mcp_session is None:
                    self._mcp_post({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "pim-cua-bridge", "version": VERSION}}}, timeout, opening=True)
                    self._mcp_post({"jsonrpc": "2.0", "method": "notifications/initialized"}, timeout)
                status, answer = self._mcp_post(request, timeout)
                if status in (400, 404) and attempt == 0:
                    self.mcp_session = None
                    continue
                if status != 200 or not isinstance(answer, dict):
                    raise Refusal(502, "The Cua driver refused the call (HTTP %d)." % status)
                return answer
        raise Refusal(502, "The Cua driver refused the call.")

    def _mcp_post(self, payload, timeout, opening=False):
        connection = self.connection(timeout)
        headers = {
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
            "x-cua-env-authorization": "Bearer " + self.token,
            "x-cua-agent-session": "pim-cua-bridge",
        }
        if self.mcp_session:
            headers["mcp-session-id"] = self.mcp_session
        try:
            connection.request("POST", "/mcp", body=json.dumps(payload).encode(), headers=headers)
            response = connection.getresponse()
            body = response.read(16 << 20)
            if opening:
                session = response.getheader("mcp-session-id")
                if response.status != 200 or not session:
                    raise Refusal(502, "The Cua driver didn't open a session.")
                self.mcp_session = session
            if response.status == 202 or not body:
                return response.status, None
            if (response.getheader("content-type") or "").startswith("text/event-stream"):
                data = [line[5:].strip() for line in body.decode("utf-8", "replace").splitlines() if line.startswith("data:")]
                body = data[-1].encode() if data else b"null"
            try:
                return response.status, json.loads(body)
            except ValueError:
                return response.status, None
        except OSError:
            raise Refusal(502, "The Cua driver didn't answer.") from None
        finally:
            connection.close()


GRPC_CODES = {"3": "invalid argument", "4": "deadline exceeded", "5": "not found", "7": "permission denied", "8": "resource exhausted", "9": "failed precondition", "12": "unimplemented", "13": "internal error", "14": "unavailable", "16": "unauthenticated"}


def grpc_failure(status):
    return "The Cua computer refused the call (%s)." % GRPC_CODES.get(status, "status " + status)


# ── Calls ──────────────────────────────────────────────────────────────────────────────────────

#: Runs as the desktop user, in a process spacesd starts: one file call, or `exec`'s checks before it becomes the command.
#: Paths are pim-computer's: /workspace/… is PIM_WORKSPACE, and links may not lead out of it.
HELPER = r"""
import base64, errno, json, os, re, shutil, stat, sys
request = json.loads(os.environ.pop("PIM_FSOP_REQUEST"))
ROOT = os.path.realpath(os.environ["PIM_WORKSPACE"])
W = "/workspace"
class CallError(Exception):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code
def relative(virtual):
    if not isinstance(virtual, str) or not virtual.startswith("/") or "\0" in virtual:
        raise CallError("%s is not an absolute path under %s" % (virtual, W), "EINVAL")
    resolved = "/" + os.path.normpath(virtual).lstrip("/")
    if resolved == W:
        return ""
    if not resolved.startswith(W + "/"):
        raise CallError("%s is outside %s" % (virtual, W), "EACCES")
    return resolved[len(W) + 1:]
def virtual_of(local):
    rest = os.path.relpath(local, ROOT)
    return W if rest == "." else W + "/" + rest
def local(virtual):
    rest = relative(virtual)
    target = os.path.join(ROOT, rest) if rest else ROOT
    existing = target
    while True:
        if os.path.lexists(existing):
            real = os.path.realpath(existing)
            if real != ROOT and not real.startswith(ROOT + os.sep):
                raise CallError("%s leads outside %s" % (virtual, W), "EACCES")
            return target
        if existing == ROOT:
            raise CallError("ENOENT: no such file or directory '%s'" % virtual, "ENOENT")
        existing = os.path.dirname(existing)
def glob(pattern):
    source, i = "", 0
    while i < len(pattern):
        c = pattern[i]
        if c == "*" and pattern[i + 1:i + 2] == "*":
            i += 1
            if pattern[i + 1:i + 2] == "/":
                i += 1
                source += "(?:.*/)?"
            else:
                source += ".*"
        elif c == "*":
            source += "[^/]*"
        elif c == "?":
            source += "[^/]"
        else:
            source += re.escape(c)
        i += 1
    return re.compile("^" + source + "$")
def globs(value):
    values = value if isinstance(value, list) else [] if value is None else [value]
    return [glob(str(v)) for v in values]
def walk(folder, exclude, prefix=""):
    try:
        entries = sorted(os.scandir(folder), key=lambda e: e.name)
    except PermissionError:
        return
    for entry in entries:
        rel = prefix + "/" + entry.name if prefix else entry.name
        if any(g.match(rel) for g in exclude):
            continue
        directory = entry.is_dir(follow_symlinks=False)
        yield rel, entry.path, directory
        if directory:
            yield from walk(entry.path, exclude, rel)
def page(items, args):
    offset = int(args.get("offset") or 0)
    limit = args.get("limit")
    return items[offset:] if limit is None else items[offset:offset + int(limit)]
def describe(path, link=None):
    info = os.stat(path)
    link = link or os.lstat(path)
    return {"mode": info.st_mode, "mtime": info.st_mtime * 1000, "size": 0 if stat.S_ISDIR(info.st_mode) else info.st_size,
            "isFile": stat.S_ISREG(info.st_mode), "isDirectory": stat.S_ISDIR(info.st_mode), "isSymbolicLink": stat.S_ISLNK(link.st_mode)}
def grep_file(path, matcher, context):
    if os.path.getsize(path) > 10000000:
        return []
    with open(path, "rb") as handle:
        data = handle.read()
    if b"\0" in data[:8192]:
        return []
    lines = re.split(r"\r?\n", data.decode("utf-8", "replace"))
    found = []
    for index, line in enumerate(lines):
        if not matcher.search(line):
            continue
        match = {"line": index + 1, "text": line}
        if context > 0:
            match["context"] = [{"line": n + 1, "text": lines[n], "isMatch": bool(matcher.search(lines[n]))} for n in range(max(0, index - context), min(len(lines), index + context + 1))]
        found.append(match)
    return found
def handle(op, args):
    if op == "stat":
        path = local(args["path"])
        info = describe(path)
        info.update(name=os.path.basename(path), inode=os.stat(path).st_ino, size=os.stat(path).st_size)
        return info
    if op == "read":
        path = local(args["path"])
        with open(path, "rb") as handle:
            size = os.fstat(handle.fileno()).st_size
            handle.seek(int(args.get("offset") or 0))
            data = handle.read(min(int(args.get("length") or 1048576), 1048576))
        return {"data": base64.b64encode(data).decode(), "size": size}
    if op == "write":
        path = local(args["path"])
        data = base64.b64decode(args.get("data") or "", validate=True)
        flags = os.O_WRONLY | os.O_CREAT | (os.O_APPEND if args.get("append") else os.O_TRUNC)
        mode = args.get("mode")
        fd = os.open(path, flags, 0o666 if mode is None else mode & 0o777)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        return None
    if op == "mkdir":
        path = local(args["path"])
        if args.get("recursive"):
            os.makedirs(path, exist_ok=True)
        else:
            os.mkdir(path)
        return None
    if op == "rm":
        path = local(args["path"])
        if path == ROOT:
            raise CallError(W + " itself can't be deleted", "EPERM")
        if not os.path.lexists(path):
            if args.get("force"):
                return None
            raise CallError("ENOENT: no such file or directory '%s'" % args["path"], "ENOENT")
        if os.path.isdir(path) and not os.path.islink(path):
            if not args.get("recursive"):
                raise CallError("EISDIR: is a directory '%s'" % args["path"], "EISDIR")
            shutil.rmtree(path)
        else:
            os.unlink(path)
        return None
    if op == "rename":
        os.rename(local(args["from"]), local(args["to"]))
        return None
    if op == "readdir":
        folder = local(args["path"])
        entries = []
        for name in page(sorted(os.listdir(folder)), args):
            full = os.path.join(folder, name)
            link = os.lstat(full)
            try:
                info = describe(full, link)
            except OSError:
                info = {"mode": link.st_mode, "mtime": link.st_mtime * 1000, "size": link.st_size, "isFile": False, "isDirectory": False, "isSymbolicLink": True}
            info.update(name=name, parentPath=virtual_of(folder))
            entries.append(info)
        return entries
    if op == "find":
        folder = local(args.get("path") or W)
        pattern = glob(str(args.get("pattern") or "**"))
        end = int(args.get("offset") or 0) + int(args.get("limit") or 10 ** 9)
        found = []
        for rel, full, directory in walk(folder, globs(args.get("exclude"))):
            if pattern.match(rel):
                found.append({"path": virtual_of(full), "type": "dir" if directory else "file"})
                if len(found) >= end:
                    break
        return page(found, args)
    if op == "grep":
        target = local(args.get("path") or W)
        query = str(args.get("query") or "")
        matcher = re.compile(query if args.get("regex") else re.escape(query), re.IGNORECASE if args.get("ignoreCase") else 0)
        context = min(int(args.get("context") or 0), 10)
        include = None if args.get("include") is None else globs(args.get("include"))
        end = int(args.get("offset") or 0) + int(args.get("limit") or 10 ** 9)
        files = []
        if os.path.isdir(target):
            for rel, full, directory in walk(target, globs(args.get("exclude"))):
                if not directory and (include is None or any(g.match(rel) for g in include)):
                    files.append(full)
        else:
            files.append(target)
        matches = []
        for path in files:
            try:
                for match in grep_file(path, matcher, context):
                    match["path"] = virtual_of(path)
                    matches.append(match)
            except OSError:
                pass
            if len(matches) >= end:
                break
        return page(matches, args)
    if op == "exec":
        cwd = local(args["cwd"]) if args.get("cwd") else ROOT
        os.chdir(cwd)
        os.environ["PIM_WORKSPACE"] = ROOT
        sys.stdout.flush()
        os.execv("/bin/bash", ["bash", "-lc", args["command"]])
    raise CallError("This bridge doesn't know the call " + op, "ENOSYS")
REASONS = {"ENOENT": "no such file or directory", "EEXIST": "file already exists", "ENOTDIR": "not a directory", "EISDIR": "is a directory",
           "ENOTEMPTY": "directory not empty", "EACCES": "permission denied", "EPERM": "operation not permitted"}
try:
    print(json.dumps({"result": handle(request["op"], request["args"])}))
except CallError as error:
    print(json.dumps({"error": {"message": str(error), "code": error.code}}))
    sys.exit(213)
except OSError as error:
    code = errno.errorcode.get(error.errno or 0)
    at = request["args"].get("path") or request["args"].get("from") or W
    message = "%s: %s '%s'" % (code, REASONS[code], at) if code in REASONS else "%s '%s'" % (error.strerror or "failed", at)
    print(json.dumps({"error": {"message": message, "code": code}}))
    sys.exit(213)
except (re.error, ValueError) as error:
    print(json.dumps({"error": {"message": str(error)[:300], "code": "EINVAL"}}))
    sys.exit(213)
"""


class Output:
    """A stream's first and last `max / 2` bytes, as pim-computer keeps a command's output."""

    def __init__(self, maximum):
        self.half = maximum // 2
        self.head = b""
        self.tail = b""
        self.dropped = False

    def add(self, chunk):
        if len(self.head) < self.half:
            room = self.half - len(self.head)
            self.head += chunk[:room]
            chunk = chunk[room:]
        if chunk:
            self.tail += chunk
            if len(self.tail) > self.half:
                self.tail = self.tail[-self.half :]
                self.dropped = True

    def text(self):
        head = self.head.decode("utf-8", "replace")
        tail = self.tail.decode("utf-8", "replace")
        return head + "\n[… output cut …]\n" + tail if self.dropped else head + tail


SIGNALS = {number.value: number.name for number in signal.Signals}

PATH = {"type": str, "max": 4096}
SCHEMAS = {
    "stat": {"path": PATH},
    "read": {"path": PATH, "offset": {"type": int, "min": 0}, "length": {"type": int, "min": 0, "max": MAX_READ}},
    "write": {"path": PATH, "data": {"type": str, "max": MAX_WRITE_BASE64}, "append": {"type": bool}, "mode": {"type": int, "min": 0, "max": 0o777}},
    "mkdir": {"path": PATH, "recursive": {"type": bool}},
    "rm": {"path": PATH, "recursive": {"type": bool}, "force": {"type": bool}},
    "rename": {"from": PATH, "to": PATH},
    "readdir": {"path": PATH, "limit": {"type": int, "min": 0, "max": 100_000}, "offset": {"type": int, "min": 0}},
    "find": {"path": PATH, "pattern": {"type": str, "max": 1000}, "limit": {"type": int, "min": 0, "max": 100_000}, "offset": {"type": int, "min": 0}, "exclude": {"type": list, "max": 50}},
    "grep": {
        "query": {"type": str, "max": 1000},
        "path": PATH,
        "regex": {"type": bool},
        "ignoreCase": {"type": bool},
        "context": {"type": int, "min": 0, "max": 10},
        "limit": {"type": int, "min": 0, "max": 100_000},
        "offset": {"type": int, "min": 0},
        "include": {"type": (str, list), "max": 50},
        "exclude": {"type": list, "max": 50},
    },
    "exec": {"command": {"type": str, "max": 100_000}, "cwd": PATH, "timeoutMs": {"type": int, "min": 1, "max": MAX_COMMAND_MS}, "maxBytes": {"type": int, "min": 1, "max": MAX_OUTPUT}},
}
REQUIRED = {"stat": ("path",), "read": ("path",), "write": ("path",), "mkdir": ("path",), "rm": ("path",), "rename": ("from", "to"), "readdir": ("path",), "exec": ("command",)}


def check(args, schema, required=()):
    if not isinstance(args, dict):
        raise Refusal(400, "args must be an object")
    for key, value in args.items():
        rule = schema.get(key)
        if rule is None:
            raise Refusal(400, "%s isn't an argument of this call" % key)
        if value is None and key not in required:
            continue
        kind = rule["type"]
        if (kind is int and (isinstance(value, bool) or not isinstance(value, int))) or not isinstance(value, kind):
            raise Refusal(400, "%s has the wrong type" % key)
        if isinstance(value, (str, list)) and len(value) > rule.get("max", 10**9):
            raise Refusal(413, "%s is too long" % key)
        if isinstance(value, list) and not all(isinstance(item, str) and len(item) <= 1000 for item in value):
            raise Refusal(400, "%s must be a list of short strings" % key)
        if isinstance(value, int) and not isinstance(value, bool) and not rule.get("min", -(10**18)) <= value <= rule.get("max", 10**18):
            raise Refusal(400, "%s is out of range" % key)
        if rule is PATH and (not value.startswith(WORKSPACE) or "\0" in value):
            raise Refusal(400, "%s must be a path under %s" % (key, WORKSPACE))
    for key in required:
        if args.get(key) is None:
            raise Refusal(400, "%s is required" % key)


def run_call(config, spacesd, op, args):
    """One of pim-computer's calls, run as the desktop user through spacesd: (result, error)."""
    if op not in SCHEMAS:
        raise Refusal(400, "unknown call")
    check(args, SCHEMAS[op], REQUIRED.get(op, ()))
    if op == "exec" and not args["command"].strip():
        raise Refusal(400, "command must be a shell command")
    timeout = -(-args.get("timeoutMs", 120_000) // 1000) if op == "exec" else 30
    env = {"PIM_FSOP_REQUEST": json.dumps({"op": op, "args": args}), "PIM_WORKSPACE": config["root"]}
    request = start_process_request(config, ["-I", "-c", HELPER], env, timeout)
    stdout = Output(args.get("maxBytes", MAX_OUTPUT)) if op == "exec" else None
    stderr = Output(args.get("maxBytes", MAX_OUTPUT)) if op == "exec" else None
    captured = bytearray()
    end = None
    for message in spacesd.grpc("cua.env.v1.ProcessService/StartProcess", request, timeout + 20):
        event = parse(last(parse(message), 1, b""))
        if 2 in event:
            data = parse(last(event, 2))
            out, err = last(data, 2), last(data, 3)
            if op == "exec":
                if out:
                    stdout.add(out)
                if err:
                    stderr.add(err)
            elif out and len(captured) < 3 << 20:
                captured += out
        if 3 in event:
            end = parse(last(event, 3))
    if end is None:
        raise Refusal(502, "The Cua computer stopped answering before the call ended.")
    exit_code = int32(last(end, 1)) if 1 in end else None
    failed = last(end, 4, b"").decode("utf-8", "replace")
    if op == "exec":
        if exit_code == HELPER_FAILED:
            try:
                return None, json.loads(stdout.head.decode())["error"]
            except (ValueError, KeyError):
                pass
        if failed:
            return {"exitCode": None, "signal": None, "stdout": "", "stderr": failed[:500], "timedOut": False, "truncated": False}, None
        return {
            "exitCode": exit_code,
            "signal": SIGNALS.get(last(end, 2, 0)) if exit_code is None else None,
            "stdout": stdout.text(),
            "stderr": stderr.text(),
            "timedOut": bool(last(end, 3, 0)),
            "truncated": stdout.dropped or stderr.dropped,
        }, None
    if failed or last(end, 3, 0):
        raise Refusal(502, "The Cua computer couldn't run the file call.")
    try:
        answer = json.loads(bytes(captured).decode("utf-8"))
    except ValueError:
        raise Refusal(502, "The file call failed on the Cua computer.") from None
    if "error" in answer:
        error = answer["error"]
        return None, {"message": str(error.get("message", "failed"))[:500], "code": error.get("code")}
    return answer.get("result"), None


TEXT_ID = {"type": str, "max": 200}
SESSION_ARG = {"type": str, "fixed": SESSION}
DRIVER_TOOLS = {
    "start_session": {"session": SESSION_ARG},
    "browser_prepare": {"session": SESSION_ARG, "allow_launch": {"type": bool, "fixed": True}, "profile": {"type": dict, "fixed": {"mode": "isolated_named", "name": SESSION}}},
    "list_windows": {"pid": {"type": int}},
    "get_browser_state": {
        "session": SESSION_ARG,
        "pid": {"type": int},
        "window_id": {"type": int},
        "target_id": TEXT_ID,
        "tab_id": TEXT_ID,
        "snapshot_format": {"type": str, "fixed": "semantic_v2"},
        "include_screenshot": {"type": bool},
        "continuation": {"type": str, "max": 2000},
    },
    "browser_navigate": {"session": SESSION_ARG, "target_id": TEXT_ID, "tab_id": TEXT_ID, "url": {"type": str, "max": 4096, "url": True}},
    "browser_click": {"session": SESSION_ARG, "target_id": TEXT_ID, "tab_id": TEXT_ID, "ref": TEXT_ID, "delivery_mode": {"type": str, "fixed": "foreground"}},
    "browser_type": {"session": SESSION_ARG, "target_id": TEXT_ID, "tab_id": TEXT_ID, "ref": TEXT_ID, "text": {"type": str, "max": 2000}, "replace": {"type": bool}, "mode": {"type": str, "one_of": ("insert_text", "keystrokes")}},
    "end_session": {"session": SESSION_ARG},
}
DRIVER_REQUIRED = {
    "start_session": ("session",),
    "browser_prepare": ("session", "allow_launch", "profile"),
    "list_windows": ("pid",),
    "get_browser_state": ("session",),
    "browser_navigate": ("session", "target_id", "tab_id", "url"),
    "browser_click": ("session", "target_id", "tab_id", "ref"),
    "browser_type": ("session", "target_id", "tab_id", "ref", "text"),
    "end_session": ("session",),
}


def check_driver(tool, arguments):
    schema = DRIVER_TOOLS.get(tool)
    if schema is None:
        raise Refusal(400, "unknown driver tool")
    if not isinstance(arguments, dict):
        raise Refusal(400, "arguments must be an object")
    for key, value in arguments.items():
        rule = schema.get(key)
        if rule is None:
            raise Refusal(400, "%s isn't an argument of %s" % (key, tool))
        kind = rule["type"]
        if (kind is int and isinstance(value, bool)) or not isinstance(value, kind):
            raise Refusal(400, "%s has the wrong type" % key)
        if "fixed" in rule and value != rule["fixed"]:
            raise Refusal(400, "%s must be %s" % (key, json.dumps(rule["fixed"])))
        if "one_of" in rule and value not in rule["one_of"]:
            raise Refusal(400, "%s is not allowed" % key)
        if isinstance(value, str) and len(value) > rule.get("max", 10**9):
            raise Refusal(413, "%s is too long" % key)
        if rule.get("url") and not re.match(r"^(https?://[^\s]+|about:blank)$", value):
            raise Refusal(400, "url must be an http(s) address")
    for key in DRIVER_REQUIRED[tool]:
        if key not in arguments:
            raise Refusal(400, "%s is required" % key)


def run_driver(spacesd, tool, arguments):
    check_driver(tool, arguments)
    answer = spacesd.mcp({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": arguments}}, 90)
    if "error" in answer:
        raise Refusal(502, "The Cua driver refused %s." % tool)
    result = answer.get("result") if isinstance(answer.get("result"), dict) else {}
    content = result.get("content") if isinstance(result.get("content"), list) else []
    text = "\n".join(str(part.get("text", "")) for part in content if isinstance(part, dict) and part.get("type") == "text")[:20_000]
    image = next((part.get("data") for part in content if isinstance(part, dict) and part.get("type") == "image" and part.get("mimeType") == "image/png"), None)
    structured = result.get("structuredContent") if isinstance(result.get("structuredContent"), dict) else None
    return {"structured": structured, "text": text, "image": image if isinstance(image, str) else None, "isError": result.get("isError") is True}


def mint_viewer(spacesd):
    answers = list(spacesd.grpc("cua.env.v1.SystemService/CreateViewerTicket", viewer_ticket_request(), 15))
    if len(answers) != 1:
        raise Refusal(502, "The Cua computer didn't make a viewer ticket.")
    answer = parse(answers[0])
    path = last(answer, 3, b"").decode("utf-8", "replace")
    expires = parse(last(answer, 2, b""))
    if not re.fullmatch(r"/viewer/#ticket=[A-Za-z0-9._~\-]{16,512}", path):
        raise Refusal(502, "The Cua computer's viewer ticket wasn't what this bridge expects.")
    return {"viewerPath": path, "expiresAt": int(last(expires, 1, 0))}


# ── HTTP ───────────────────────────────────────────────────────────────────────────────────────


class Window:
    """Events in the last `seconds`, at most `limit`."""

    def __init__(self, limit, seconds):
        self.limit, self.seconds, self.times = limit, seconds, []

    def full(self, now):
        self.times = [t for t in self.times if now - t < self.seconds]
        return len(self.times) >= self.limit

    def add(self, now):
        self.times.append(now)


class Bridge:
    def __init__(self, config, spacesd=None):
        self.config = config
        self.spacesd = spacesd or Spacesd(config["token"])
        self.lock = threading.Lock()
        self.inflight = 0
        self.requests = Window(*RATE)
        self.failures = Window(*AUTH_FAILURES)

    def authorized(self, header):
        scheme, _, token = (header or "").partition(" ")
        presented = hashlib.sha256(token.strip().encode("utf-8")).digest()
        return scheme == "Bearer" and hmac.compare_digest(presented, self.config["digest"])

    def serve(self, handler):
        started = time.monotonic()
        route = "-"
        try:
            route, payload = self.admit(handler)
            status, body = 200, self.dispatch(route, payload)
        except Refusal as refusal:
            status, body = refusal.status, {"error": {"message": str(refusal)[:500], "code": refusal.code}}
        except Exception:  # noqa: BLE001 - nothing about it goes back, or to the log, but its kind
            status, body = 500, {"error": {"message": "The bridge failed.", "code": None}}
            print(json.dumps({"event": "error", "route": route, "kind": type(sys.exc_info()[1]).__name__}), file=sys.stderr, flush=True)
        data = json.dumps(body).encode("utf-8")
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(data)))
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("X-Content-Type-Options", "nosniff")
        if status >= 400:
            handler.send_header("Connection", "close")
            handler.close_connection = True
        handler.end_headers()
        handler.wfile.write(data)
        # Method, route, status and time only: never headers, a query, a body or an address.
        print(json.dumps({"event": "request", "route": route, "status": status, "ms": round((time.monotonic() - started) * 1000)}), file=sys.stderr, flush=True)

    def admit(self, handler):
        if handler.command != "POST":
            raise Refusal(405, "Only POST")
        if not handler.path.startswith(PREFIX) or handler.path[len(PREFIX) :] not in ROUTES:
            raise Refusal(404, "Not found")
        route = handler.path[len(PREFIX) :]
        now = time.monotonic()
        with self.lock:
            if self.failures.full(now) or self.requests.full(now):
                raise Refusal(429, "Too many requests")
            self.requests.add(now)
        if handler.headers.get("Transfer-Encoding"):
            raise Refusal(411, "Send a Content-Length")
        try:
            length = int(handler.headers.get("Content-Length", ""))
        except ValueError:
            raise Refusal(411, "Send a Content-Length") from None
        if length < 0 or length > MAX_BODY:
            raise Refusal(413, "Too large")
        if not self.authorized(handler.headers.get(AUTH_HEADER)):
            with self.lock:
                self.failures.add(now)
            raise Refusal(401, "Unauthorized")
        if (handler.headers.get("Content-Type") or "").split(";")[0].strip() != "application/json":
            raise Refusal(415, "Send JSON")
        try:
            payload = json.loads(handler.rfile.read(length) or b"{}")
        except ValueError:
            raise Refusal(400, "Send a JSON object") from None
        if not isinstance(payload, dict):
            raise Refusal(400, "Send a JSON object")
        return route, payload

    def dispatch(self, route, payload):
        if route == "status":
            return {"ok": self.spacesd.health(), "inflight": self.inflight, "version": VERSION}
        if route == "viewer":
            with self.lock:
                if self.inflight > 0:
                    raise Refusal(409, "Agent calls are still under way on the Cua computer.", "busy")
            return mint_viewer(self.spacesd)
        with self.lock:
            if self.inflight >= MAX_INFLIGHT:
                raise Refusal(429, "Too many calls at once")
            self.inflight += 1
        try:
            if route == "call":
                result, error = run_call(self.config, self.spacesd, payload.get("op"), payload.get("args", {}))
                return {"error": error} if error else {"result": result}
            return run_driver(self.spacesd, payload.get("tool"), payload.get("arguments", {}))
        finally:
            with self.lock:
                self.inflight -= 1


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "pim-cua-bridge"
    sys_version = ""
    timeout = 30

    def log_message(self, *_args):
        pass

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except OSError:
            self.close_connection = True

    def do_POST(self):
        self.server.bridge.serve(self)

    do_GET = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = do_POST


def serve(config, spacesd=None):
    server = http.server.ThreadingHTTPServer((config["host"], config["port"]), Handler)
    server.daemon_threads = True
    server.bridge = Bridge(config, spacesd)
    return server


def main():
    config = load_config(os.environ)
    server = serve(config)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown).start())
    print(json.dumps({"event": "listening", "address": "%s:%d" % (config["host"], config["port"]), "version": VERSION}), file=sys.stderr, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
