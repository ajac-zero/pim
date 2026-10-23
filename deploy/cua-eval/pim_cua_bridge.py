#!/usr/bin/env python3
"""pim-cua-bridge: who has one Cua machine, Pim's agents or the person, and the few calls the agents make there.

A private evaluation prototype, not a product (see docs/cua-evaluation.md). It runs on the Cua
VM, bound to loopback, behind the VM's Caddy (Caddyfile.pim-bridge). It is the only holder of
cua-spacesd's root token besides spacesd itself: Pim sends its own machine credential, never the
root token, and the root token never leaves the VM. Every call goes to the one spacesd on this
machine at 127.0.0.1:3211, which is fixed: no call names a URL, a host or a spacesd method.

The bridge, not Pim, decides who has the machine, and keeps it in a file (PIM_BRIDGE_STATE) so a
restart keeps it: `human` (the default, and where it starts with no file), `agents`, `draining`
(agents' work is finishing) or `handoff` (the person's viewer sessions are closing). Agents' calls
carry the lease Pim was given when the person resumed them, and run only while the machine is the
agents' under that same lease. The person's viewer opens its media sessions through the bridge
(`media/open`), which records each one and refuses while agents have the machine; resuming closes
every one of them first (StreamService.CloseMedia). Viewer tickets can't open anything once agents
have the machine, since the only way they reach the desktop is a media session.

Pim's routes, with its credential in X-Pim-Bridge-Authorization:

- `status`: who has the machine, its lease, and what of the agents' is still under way.
- `call`: one of pim-computer's file and command calls (computer/pim-computer.ts's `handle`):
  stat, read, write, mkdir, rm, rename, readdir, find, grep, exec. Each runs as one process that
  spacesd starts, tagged `pim-…`, as PIM_BRIDGE_RUN_AS (never root nor an administrator), which
  checks its paths against PIM_BRIDGE_ROOT after following links. A command's process stays,
  as the subreaper of everything the command started, until the last of those ends.
- `driver`: one of eight cua-driver tools for the browser over spacesd's /mcp, with fixed shapes:
  one driver session (`pim`), an isolated named profile (`pim`), never an existing profile.
- `pause`: agents' calls stop being taken at once; the machine is the person's once nothing of
  the agents' runs: no call here, no `pim-` process in spacesd, and, after a restart, long enough
  for a driver call the bridge lost track of to have ended.
- `resume`: the person's viewer sessions are closed, then the machine is the agents', under a new lease.
- `viewer`: a short-lived viewer ticket (SystemService.CreateViewerTicket), only while it's the person's.

And the viewer's one route, with its viewer ticket, which spacesd checks: `media/open`, where
Caddy sends StreamService/OpenMedia.

Only Python 3's standard library. Settings come from the environment (pim-cua-bridge.env.example);
the root token from the spacesd env file systemd hands over as a credential. It refuses to start
without a sound credential digest, a user without administrator rights, a workspace root, the root
token and a sound state file, and on anything but a loopback address.
"""

import base64
import grp
import hashlib
import hmac
import http.client
import http.server
import ipaddress
import json
import os
import pwd
import re
import signal
import sys
import threading
import time
import uuid

VERSION = "0.2.0"
#: The one spacesd this bridge reaches. Not configurable.
SPACESD = ("127.0.0.1", 3211)
PREFIX = "/pim-bridge/v1/"
ROUTES = ("status", "call", "driver", "viewer", "pause", "resume")
#: Where Caddy sends the viewer's StreamService/OpenMedia.
MEDIA_ROUTE = PREFIX + "media/open"
MAX_MEDIA_BODY = 64 * 1024
MEDIA_RATE = (30, 60.0)
#: Tags of the processes the agents' calls start in spacesd.
TAG_PREFIX = "pim-"
#: After a restart, how long a driver call the bridge had under way, and lost track of, may still be running.
QUIET_AFTER_RESTART = 120
#: The administrator groups the agents' user may not be in.
ADMIN_GROUPS = frozenset({"sudo", "admin", "wheel", "root"})
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


def admin_groups(user):
    """The administrator groups `user` is in, or None when there's no such user. Sudoers files aren't read: see the docs."""
    try:
        entry = pwd.getpwnam(user)
    except KeyError:
        return None
    if entry.pw_uid == 0:
        return {"root"}
    names = {group.gr_name for group in grp.getgrall() if user in group.gr_mem}
    try:
        names.add(grp.getgrgid(entry.pw_gid).gr_name)
    except KeyError:
        pass
    return names & ADMIN_GROUPS


def load_config(environ, groups_of=admin_groups):
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
        problems.append("PIM_BRIDGE_RUN_AS must name the agents' user, not root")
    else:
        admin = groups_of(run_as)
        if admin is None:
            problems.append("PIM_BRIDGE_RUN_AS names no user on this machine")
        elif admin:
            problems.append("PIM_BRIDGE_RUN_AS must be a user without administrator rights, not one in %s" % ", ".join(sorted(admin)))
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
        "state": environ.get("PIM_BRIDGE_STATE") or os.path.join(environ.get("STATE_DIRECTORY", "/var/lib/pim-cua-bridge"), "state.json"),
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


def start_process_request(config, args, env, tag, timeout_seconds=None):
    """StartProcessRequest (process.proto): `python3 -I -c HELPER` as the agents' user, tagged `tag`.

    A file call has a time limit and ends with this request. A command has neither: its helper
    enforces the command's limit itself, and stays, as long as anything the command started does.
    """
    environment = b"".join(field_bytes(3, field_string(1, key) + field_string(2, value)) for key, value in env.items())
    process = (
        field_string(1, config["python"])
        + b"".join(field_string(2, arg) for arg in args)
        + environment
        + field_string(4, "/")
        + field_string(5, config["run_as"])
        + (field_bytes(6, field_varint(1, timeout_seconds)) if timeout_seconds else b"")
    )
    # config, tag, keepalive_interval (15 s), scrollback_bytes (4 MiB), kill_on_disconnect.
    return field_bytes(1, process) + field_string(3, tag) + field_bytes(5, field_varint(1, 15)) + field_varint(6, 4 << 20) + field_varint(7, 1 if timeout_seconds else 0)


def list_processes_request():
    """ListProcessesRequest (process.proto): running processes whose tag starts with TAG_PREFIX."""
    return field_string(2, TAG_PREFIX)


def close_media_request(media_session_id):
    """CloseMediaRequest (stream.proto)."""
    return field_string(1, media_session_id)


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
                raise Refusal(502, grpc_failure(status), "grpc-" + status)
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
                raise Refusal(502, grpc_failure(status.group(1)), "grpc-" + status.group(1))
        except OSError:
            raise Refusal(502, "The Cua computer didn't answer.") from None
        finally:
            connection.close()

    def forward_open_media(self, body, content_type, ticket):
        """The viewer's own OpenMedia, with its own viewer ticket and never the root token: (status, headers, body)."""
        connection = self.connection(20)
        try:
            connection.request(
                "POST",
                "/cua.env.v1.StreamService/OpenMedia",
                body=body,
                headers={"content-type": content_type, "accept": content_type, "x-grpc-web": "1", "x-cua-env-authorization": "Bearer " + ticket},
            )
            response = connection.getresponse()
            answer = response.read(MAX_MEDIA_BODY + 1)
            if len(answer) > MAX_MEDIA_BODY:
                raise Refusal(502, "The Cua computer's answer was too large.")
            kept = {name: response.getheader(name) for name in ("content-type", "grpc-status", "grpc-message") if response.getheader(name) is not None}
            return response.status, kept, answer
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
        run_command(local(args["cwd"]) if args.get("cwd") else ROOT, args)
    raise CallError("This bridge doesn't know the call " + op, "ENOSYS")
class Output:
    def __init__(self, maximum):
        self.half, self.head, self.tail, self.dropped = maximum // 2, b"", b"", False
    def add(self, chunk):
        if len(self.head) < self.half:
            room = self.half - len(self.head)
            self.head, chunk = self.head + chunk[:room], chunk[room:]
        if chunk:
            self.tail += chunk
            if len(self.tail) > self.half:
                self.tail, self.dropped = self.tail[-self.half:], True
    def text(self):
        head, tail = self.head.decode("utf-8", "replace"), self.tail.decode("utf-8", "replace")
        return head + "\n[\u2026 output cut \u2026]\n" + tail if self.dropped else head + tail
def run_command(cwd, args):
    # The command runs in a process group of its own, under this process as its subreaper: whatever
    # it starts, detached or not, stays this process's descendant, so this process (tagged in spacesd)
    # runs until the last of them ends, and the bridge counts it as the agents' work until then.
    import ctypes, selectors, signal, subprocess, time
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise CallError("This computer can't keep track of what a command starts", "ENOSYS")
    limit = int(args.get("maxBytes") or 64000)
    deadline = time.monotonic() + int(args.get("timeoutMs") or 120000) / 1000
    child = subprocess.Popen(["/bin/bash", "-lc", args["command"]], cwd=cwd, env=dict(os.environ, PIM_WORKSPACE=ROOT),
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, preexec_fn=os.setpgrp)
    fds = []
    for pipe in (child.stdout, child.stderr):
        fds.append(os.dup(pipe.fileno()))
        pipe.close()
    outputs = {fd: Output(limit) for fd in fds}
    selector = selectors.DefaultSelector()
    for fd in outputs:
        os.set_blocking(fd, False)
        selector.register(fd, selectors.EVENT_READ)
    def pump(timeout, keep=True):
        if not selector.get_map():
            time.sleep(timeout)
            return False
        ready = selector.select(timeout)
        for key, _ in ready:
            try:
                chunk = os.read(key.fd, 65536)
            except BlockingIOError:
                continue
            if not chunk:
                selector.unregister(key.fd)
                os.close(key.fd)
            elif keep:
                outputs[key.fd].add(chunk)
        return bool(ready)
    timed_out, kill_at = False, None
    while child.poll() is None:
        now = time.monotonic()
        if not timed_out and now >= deadline:
            timed_out, kill_at = True, now + 5
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        elif kill_at is not None and now >= kill_at:
            kill_at = None
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        pump(0.05)
    until = time.monotonic() + 0.5
    while time.monotonic() < until and pump(0.02):
        pass
    code = child.returncode
    out, err = outputs[fds[0]], outputs[fds[1]]
    result = {"exitCode": code if code >= 0 else None, "signal": signal.Signals(-code).name if code < 0 else None,
              "stdout": out.text(), "stderr": err.text(), "timedOut": timed_out, "truncated": out.dropped or err.dropped}
    sys.stdout.write("\x1epim-result " + json.dumps(result) + "\n")
    sys.stdout.flush()
    quiet = os.open(os.devnull, os.O_RDWR)
    os.dup2(quiet, 1)
    os.dup2(quiet, 2)
    # Then wait for everything the command left running, reading and dropping what it still writes.
    while True:
        pump(0.5, keep=False)
        try:
            while os.waitpid(-1, os.WNOHANG)[0] != 0:
                pass
        except ChildProcessError:
            os._exit(0)
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


RESULT_MARK = b"\x1epim-result "


def run_call(config, spacesd, op, args, epoch):
    """One of pim-computer's calls, run as the agents' user through spacesd: (result, error)."""
    if op not in SCHEMAS:
        raise Refusal(400, "unknown call")
    check(args, SCHEMAS[op], REQUIRED.get(op, ()))
    if op == "exec" and not args["command"].strip():
        raise Refusal(400, "command must be a shell command")
    command = op == "exec"
    tag = "%s%s-%d-%s" % (TAG_PREFIX, "exec" if command else "call", epoch, uuid.uuid4().hex[:12])
    env = {"PIM_FSOP_REQUEST": json.dumps({"op": op, "args": args}), "PIM_WORKSPACE": config["root"]}
    request = start_process_request(config, ["-I", "-c", HELPER], env, tag, None if command else 30)
    wait = -(-args.get("timeoutMs", 120_000) // 1000) + 30 if command else 50
    captured = bytearray()
    end = None
    for message in spacesd.grpc("cua.env.v1.ProcessService/StartProcess", request, wait):
        event = parse(last(parse(message), 1, b""))
        if 2 in event:
            out = last(parse(last(event, 2)), 2)
            if out and len(captured) < 3 << 20:
                captured += out
            if command:
                # A command's answer is the helper's mark; the helper stays for what the command left running.
                mark = captured.find(RESULT_MARK)
                line = captured.find(b"\n", mark) if mark >= 0 else -1
                if line >= 0:
                    try:
                        return json.loads(bytes(captured[mark + len(RESULT_MARK) : line]).decode("utf-8")), None
                    except ValueError:
                        raise Refusal(502, "The command's answer was garbled.") from None
        if 3 in event:
            end = parse(last(event, 3))
    if end is None:
        raise Refusal(502, "The Cua computer stopped answering before the call ended.")
    exit_code = int32(last(end, 1)) if 1 in end else None
    if last(end, 4, b"") or last(end, 3, 0):
        raise Refusal(502, "The Cua computer couldn't run the call.")
    try:
        answer = json.loads(bytes(captured).decode("utf-8"))
    except ValueError:
        raise Refusal(502, "The call failed on the Cua computer.") from None
    if "error" in answer:
        error = answer["error"]
        return None, {"message": str(error.get("message", "failed"))[:500], "code": error.get("code")}
    if command or exit_code != 0:
        raise Refusal(502, "The call failed on the Cua computer.")
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


def running_agent_processes(spacesd):
    """How many processes the agents' calls started are still running in spacesd (ListProcesses, by tag)."""
    count = 0
    for answer in spacesd.grpc("cua.env.v1.ProcessService/ListProcesses", list_processes_request(), 10):
        for info in parse(answer).get(1, []):
            fields = parse(info)
            if last(fields, 2, b"").decode("utf-8", "replace").startswith(TAG_PREFIX) and last(fields, 5, 0) != 2:
                count += 1
    return count


def close_media(spacesd, media_session_id):
    """Closes one of the person's media sessions; one spacesd no longer has (NOT_FOUND) is closed already."""
    try:
        list(spacesd.grpc("cua.env.v1.StreamService/CloseMedia", close_media_request(media_session_id), 10))
    except Refusal as refusal:
        if refusal.code != "grpc-5":
            raise


def grpc_web_frames(body):
    """A gRPC-Web body's (flags, message) frames, or ValueError."""
    frames, index = [], 0
    while index < len(body):
        if index + 5 > len(body):
            raise ValueError("truncated frame")
        length = int.from_bytes(body[index + 1 : index + 5], "big")
        message = body[index + 5 : index + 5 + length]
        if len(message) != length:
            raise ValueError("truncated frame")
        frames.append((body[index], message))
        index += 5 + length
    return frames


def opened_media(headers, body):
    """What an OpenMedia answer says: (ok, media_session_id or None). Raises ValueError on a garbled answer."""
    status = headers.get("grpc-status")
    frames = grpc_web_frames(body)
    for flags, message in frames:
        if flags & 0x80:
            found = re.search(r"(?im)^grpc-status:\s*(\d+)", message.decode("latin-1"))
            status = found.group(1) if found else status
    if status not in ("0", None):
        return False, None
    data = [message for flags, message in frames if not flags & 0x80]
    if status is None or len(data) != 1:
        raise ValueError("no answer")
    session = last(parse(data[0]), 1, b"").decode("utf-8", "replace")
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", session):
        raise ValueError("no session id")
    return True, session


# ── Who has the machine ────────────────────────────────────────────────────────────────────────


class State:
    """Who has the machine, under which lease, and the person's media sessions: a file, rewritten whole on each change."""

    FRESH = {"mode": "human", "epoch": 1, "media": [], "quietUntil": 0, "viewerUntil": 0}

    def __init__(self, path):
        self.path = path
        try:
            with open(path, encoding="utf-8") as handle:
                data = json.load(handle)
        except FileNotFoundError:
            data = dict(self.FRESH)
        except (OSError, ValueError):
            raise SystemExit("pim-cua-bridge won't start: its state file isn't readable JSON; with spacesd restarted (which closes every viewer session), delete it") from None
        if (
            not isinstance(data, dict)
            or data.get("mode") not in ("human", "agents", "draining", "handoff")
            or not isinstance(data.get("epoch"), int)
            or not isinstance(data.get("media"), list)
            or not all(isinstance(item, str) for item in data["media"])
        ):
            raise SystemExit("pim-cua-bridge won't start: its state file isn't one it wrote; with spacesd restarted (which closes every viewer session), delete it")
        self.data = {**self.FRESH, **data}

    def __getattr__(self, name):
        try:
            return self.__dict__["data"][name]
        except KeyError:
            raise AttributeError(name) from None

    def update(self, **changes):
        """Changes and saves it, or leaves it as it was and raises."""
        changed = {**self.data, **changes}
        temporary = "%s.%d.tmp" % (self.path, os.getpid())
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(changed, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.path)
        folder = os.open(os.path.dirname(self.path) or ".", os.O_RDONLY)
        try:
            os.fsync(folder)
        finally:
            os.close(folder)
        self.data = changed


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


PAUSED = "The person has the Cua computer now; nothing was done there."


class Bridge:
    def __init__(self, config, spacesd=None):
        self.config = config
        self.spacesd = spacesd or Spacesd(config["token"])
        #: Guards the counters and the state's reads; held only briefly.
        self.lock = threading.Lock()
        #: Serializes changing hands, minting a viewer ticket and opening a media session.
        self.transition = threading.Lock()
        self.inflight = 0
        self.requests = Window(*RATE)
        self.media_requests = Window(*MEDIA_RATE)
        self.failures = Window(*AUTH_FAILURES)
        self.state = State(config["state"])
        # A restart forgets what was under way: the agents' lease ends, and the machine is the
        # person's only once whatever the bridge had under way can have ended.
        if self.state.mode in ("agents", "draining"):
            self.state.update(mode="draining", epoch=self.state.epoch + 1, quietUntil=time.time() + QUIET_AFTER_RESTART)
        elif self.state.mode == "handoff":
            self.state.update(mode="human")

    def authorized(self, header):
        scheme, _, token = (header or "").partition(" ")
        presented = hashlib.sha256(token.strip().encode("utf-8")).digest()
        return scheme == "Bearer" and hmac.compare_digest(presented, self.config["digest"])

    def serve(self, handler):
        started = time.monotonic()
        route, status, headers = "-", 200, {"Content-Type": "application/json"}
        try:
            if handler.path == MEDIA_ROUTE:
                route = "media/open"
                status, headers, data = self.open_media(handler)
            else:
                route, payload = self.admit(handler)
                data = json.dumps(self.dispatch(route, payload)).encode("utf-8")
        except Refusal as refusal:
            status, headers = refusal.status, {"Content-Type": "application/json"}
            data = json.dumps({"error": {"message": str(refusal)[:500], "code": refusal.code}}).encode("utf-8")
        except Exception:  # noqa: BLE001 - nothing about it goes back, or to the log, but its kind
            status, headers = 500, {"Content-Type": "application/json"}
            data = json.dumps({"error": {"message": "The bridge failed.", "code": None}}).encode("utf-8")
            print(json.dumps({"event": "error", "route": route, "kind": type(sys.exc_info()[1]).__name__}), file=sys.stderr, flush=True)
        handler.send_response(status)
        for name, value in headers.items():
            handler.send_header(name, value)
        handler.send_header("Content-Length", str(len(data)))
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("X-Content-Type-Options", "nosniff")
        handler.send_header("X-Pim-Bridge", route)
        if status >= 400:
            handler.send_header("Connection", "close")
            handler.close_connection = True
        handler.end_headers()
        handler.wfile.write(data)
        # Method, route, status and time only: never headers, a query, a body or an address.
        print(json.dumps({"event": "request", "route": route, "status": status, "ms": round((time.monotonic() - started) * 1000)}), file=sys.stderr, flush=True)

    def read_body(self, handler, maximum):
        if handler.headers.get("Transfer-Encoding"):
            raise Refusal(411, "Send a Content-Length")
        try:
            length = int(handler.headers.get("Content-Length", ""))
        except ValueError:
            raise Refusal(411, "Send a Content-Length") from None
        if length < 0 or length > maximum:
            raise Refusal(413, "Too large")
        return handler.rfile.read(length)

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

    def view(self, background=None):
        state = self.state
        return {
            "ok": True,
            "mode": state.mode,
            "epoch": state.epoch,
            "inflight": self.inflight,
            "background": background,
            "quietSeconds": max(0, round(state.quietUntil - time.time())),
            "viewerSessions": len(state.media),
            "version": VERSION,
        }

    def dispatch(self, route, payload):
        if route == "status":
            with self.lock:
                return self.view()
        if route == "pause":
            return self.pause()
        if route == "resume":
            return self.resume(payload.get("epoch"))
        if route == "viewer":
            return self.viewer()
        with self.lock:
            if self.state.mode != "agents" or payload.get("lease") != self.state.epoch:
                raise Refusal(423, PAUSED, "paused")
            if self.inflight >= MAX_INFLIGHT:
                raise Refusal(429, "Too many calls at once")
            self.inflight += 1
            epoch = self.state.epoch
        try:
            if route == "call":
                result, error = run_call(self.config, self.spacesd, payload.get("op"), payload.get("args", {}), epoch)
                return {"error": error} if error else {"result": result}
            return run_driver(self.spacesd, payload.get("tool"), payload.get("arguments", {}))
        finally:
            with self.lock:
                self.inflight -= 1

    def pause(self):
        """Takes no new agent call from now on; the machine is the person's once nothing of the agents' runs."""
        with self.transition:
            with self.lock:
                if self.state.mode == "agents":
                    self.state.update(mode="draining", epoch=self.state.epoch + 1)
                if self.state.mode != "draining":
                    return self.view()
                # Nothing is admitted while draining, so once no call is under way none will be: then
                # whatever the finished calls started is in spacesd's list.
                if self.inflight > 0 or time.time() < self.state.quietUntil:
                    return self.view()
            background = running_agent_processes(self.spacesd)
            with self.lock:
                if background == 0 and self.inflight == 0:
                    self.state.update(mode="human", epoch=self.state.epoch + 1, quietUntil=0)
                return self.view(background)

    def resume(self, epoch):
        """Closes every media session of the person's, then gives the machine to the agents under a new lease."""
        with self.transition:
            with self.lock:
                if self.state.mode != "human":
                    raise Refusal(409, "The machine isn't the person's: pause the agents first.", "not-paused")
                if epoch != self.state.epoch:
                    raise Refusal(409, "This pause has ended or changed since; look again.", "stale")
                self.state.update(mode="handoff")
            try:
                for media_session_id in list(self.state.media):
                    close_media(self.spacesd, media_session_id)
                    with self.lock:
                        self.state.update(media=[item for item in self.state.media if item != media_session_id])
            except Refusal:
                with self.lock:
                    self.state.update(mode="human")
                raise Refusal(502, "The person's viewer sessions couldn't all be closed, so the agents stay paused.", "handoff")
            with self.lock:
                self.state.update(mode="agents", epoch=self.state.epoch + 1)
                return self.view()

    def viewer(self):
        with self.transition:
            with self.lock:
                if self.state.mode != "human":
                    raise Refusal(409, "The agents' work is still finishing on the Cua computer.", "busy")
            minted = mint_viewer(self.spacesd)
            with self.lock:
                self.state.update(viewerUntil=max(self.state.viewerUntil, minted["expiresAt"]))
            return minted

    def open_media(self, handler):
        """The viewer's OpenMedia: passed to spacesd with the viewer's own ticket only while the machine is the person's, and recorded."""
        refused = lambda message: (200, {"Content-Type": "application/grpc-web+proto", "grpc-status": "9", "grpc-message": message}, b"")  # noqa: E731
        if handler.command != "POST":
            raise Refusal(405, "Only POST")
        now = time.monotonic()
        with self.lock:
            if self.media_requests.full(now):
                raise Refusal(429, "Too many requests")
            self.media_requests.add(now)
        content_type = (handler.headers.get("Content-Type") or "").strip()
        if content_type not in ("application/grpc-web+proto", "application/grpc-web"):
            raise Refusal(415, "Send gRPC-Web")
        bearer = (handler.headers.get("x-cua-env-authorization") or "").strip()
        ticket = bearer[7:] if bearer[:7].lower() == "bearer " else ""
        if not re.fullmatch(r"v1\.[A-Za-z0-9._~-]{16,1024}", ticket):
            raise Refusal(401, "Send a viewer ticket")
        body = self.read_body(handler, MAX_MEDIA_BODY)
        with self.transition:
            with self.lock:
                if self.state.mode != "human":
                    return refused("Pim's agents are using this computer: pause them in Pim first.")
            # A session this doesn't record is one whose media ticket nobody gets: its answer goes no
            # further, so no socket ever attaches, and spacesd reaps it at its attach deadline.
            status, headers, answer = self.spacesd.forward_open_media(body, content_type, ticket)
            try:
                ok, media_session_id = opened_media(headers, answer) if status == 200 else (False, None)
            except ValueError:
                return refused("The bridge couldn't read spacesd's answer, so it kept it.")
            if ok:
                try:
                    with self.lock:
                        self.state.update(media=self.state.media + [media_session_id])
                except OSError:
                    return refused("The bridge couldn't record this session, so it kept its answer.")
            return status, headers, answer


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
