#!/usr/bin/env python3
"""Smoke test of the Cua evaluation end to end: a local Pim preview's real tools, through Caddy and pim-cua-bridge, on a Cua machine.

    python3 deploy/cua-eval/e2e.py owner [--user cua-e2e]     # the test account's owner id, for CUA_EVAL_OWNER
    python3 deploy/cua-eval/e2e.py run [--user cua-e2e] [--viewer-basic FILE] [--browser-url URL]

Run it on the machine with the Pim preview (`pnpm preview`, http://localhost:8787 only), whose
.dev.vars names the bridge (CUA_EVAL_BRIDGE_URL, CUA_EVAL_BRIDGE_TOKEN) and this test account's
owner id (CUA_EVAL_OWNER). It signs in through the preview's /__dev/sign-in (no passkey, no real
account), and makes the agents use their real tools with the preview's stand-in model
(`/tool <name> {json}`), approving or denying as a person would: so every call goes through Pim's
tool registry, approvals, the space's pause state, Caddy, the bridge, and the machine.

`--viewer-basic FILE` (a file holding `user:password` of the VM's viewer login, read and never
printed) adds the person's side: the viewer's own OpenMedia through Caddy with the ticket Pim
made, an attached media WebSocket, and that resuming the agents closes it and that the ticket then
opens nothing. Without it those checks are skipped.

Against the real VM this reaches only https://cua-eval.ajac-zero.com, as the preview does. It
prints what each check found, never a cookie, credential, password or ticket, and exits non-zero
when any check fails. It leaves the evaluation turned off for the test account.
"""

import argparse
import base64
import http.client
import http.cookiejar
import json
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SITE = "cua-eval.ajac-zero.com"
PAUSED = "paused agents on their Cua evaluation computer"
failures = []
secrets = []


def report(ok, what, detail=""):
    for secret in secrets:
        detail = detail.replace(secret, "[secret]")
    print(("PASS  " if ok else "FAIL  ") + what + (": " + detail if detail and not ok else ""), flush=True)
    if not ok:
        failures.append(what)
    return ok


def skip(what, why):
    print("SKIP  %s: %s" % (what, why), flush=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Pim:
    """One signed-in browser of the preview: its session cookie, and the Origin the app sends."""

    def __init__(self, base, user):
        address = urllib.parse.urlparse(base)
        if address.scheme != "http" or address.hostname not in ("localhost", "127.0.0.1"):
            raise SystemExit("--pim must be the local preview, http://localhost:8787 or another loopback address")
        self.base, self.user = base.rstrip("/"), user
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect())

    def sign_in(self):
        try:
            self.opener.open(self.base + "/__dev/sign-in/" + urllib.parse.quote(self.user) + "?returnTo=/", timeout=30)
        except urllib.error.HTTPError as error:
            if error.code not in (302, 303):
                raise SystemExit("couldn't sign in to the preview as %s (HTTP %d): is it the preview?" % (self.user, error.code)) from None
        return self

    def request(self, method, path, body=None, origin="same", bearer=None):
        """(status, JSON body or None, headers)."""
        headers = {"content-type": "application/json"}
        if origin == "same":
            headers["origin"] = self.base
        elif origin:
            headers["origin"] = origin
        if bearer:
            headers["authorization"] = "Bearer " + bearer
        else:
            # The session cookie is __Host- (Secure), which urllib keeps for https; browsers send it to localhost.
            headers["cookie"] = "; ".join("%s=%s" % (cookie.name, cookie.value) for cookie in self.jar)
        opener = urllib.request.build_opener(NoRedirect())
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with opener.open(request, timeout=180) as response:
                raw = response.read()
                status, answer_headers = response.status, response.headers
        except urllib.error.HTTPError as error:
            raw, status, answer_headers = error.read(), error.code, error.headers
        try:
            answer = json.loads(raw) if raw else None
        except ValueError:
            answer = None
        return status, answer, answer_headers

    def get(self, path):
        return self.request("GET", path)[1]

    def post(self, path, body=None, **kwargs):
        return self.request("POST", path, {} if body is None else body, **kwargs)


# ── Chats ──────────────────────────────────────────────────────────────────────────────────────


def tool_result(messages, name, after):
    """The text and error flag of the last result of tool `name` in messages after id `after`."""
    found = None
    for message in messages:
        if int(message["id"]) <= after or message.get("role") != "tool":
            continue
        for part in message.get("parts", []):
            if part.get("type") == "tool-result" and part.get("name") == name:
                text = "".join(item.get("text", "") for item in part.get("content", []) if item.get("type") == "text")
                found = (text, part.get("error") is True)
    return found


def use_tool(pim, chat, name, args, decide=None, timeout=240):
    """Asks the stand-in model to call `name`; `decide` is "approve" or "deny" for its approval, or None when none is expected.

    Returns (text, isError, approval or None)."""
    before = pim.get("/api/sessions/%s/messages" % chat)["messages"]
    after = max([int(message["id"]) for message in before] or [0])
    seen = {approval["id"] for approval in pim.get("/api/approvals?status=pending")["approvals"]}
    pim.post("/api/sessions/%s/messages" % chat, {"content": "/tool %s %s" % (name, json.dumps(args)), "wait": False})
    approval = None
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if decide and approval is None:
            fresh = [item for item in pim.get("/api/approvals?status=pending")["approvals"] if item["id"] not in seen]
            if fresh:
                approval = fresh[0]
                pim.post("/api/approvals/%s/%s" % (approval["id"], decide), {})
        page = pim.get("/api/sessions/%s/messages" % chat)
        result = tool_result(page["messages"], name, after)
        if result and not page["busy"]:
            return result[0], result[1], approval
        failed = [message.get("error") for message in page["messages"] if int(message["id"]) > after and message.get("stopReason") == "error"]
        if failed and not page["busy"]:
            raise SystemExit("the preview's model stopped: %s (raise PIM_LIMIT_DAILY_* in .dev.vars, see docs/cua-evaluation.md)" % failed[-1])
        time.sleep(0.5)
    raise SystemExit("%s didn't finish in %d s" % (name, timeout))


def ask_only(pim, chat, name, args):
    """Asks for a gated tool and leaves its approval pending: the approval."""
    seen = {approval["id"] for approval in pim.get("/api/approvals?status=pending")["approvals"]}
    pim.post("/api/sessions/%s/messages" % chat, {"content": "/tool %s %s" % (name, json.dumps(args)), "wait": False})
    for _ in range(120):
        fresh = [item for item in pim.get("/api/approvals?status=pending")["approvals"] if item["id"] not in seen]
        if fresh:
            return fresh[0]
        time.sleep(0.5)
    raise SystemExit("no approval was asked for %s" % name)


def wait_idle(pim, chat, timeout=240):
    deadline = time.monotonic() + timeout
    while pim.get("/api/sessions/%s/messages" % chat)["busy"] and time.monotonic() < deadline:
        time.sleep(0.5)


# ── The machine's hand-off ─────────────────────────────────────────────────────────────────────


def pause(pim, until="paused", timeout=240):
    deadline = time.monotonic() + timeout
    view = None
    while time.monotonic() < deadline:
        view = pim.post("/api/cua/pause")[1]
        if view.get("mode") == until:
            return view
        time.sleep(1)
    return view


def resume(pim):
    view = pim.get("/api/cua")
    return pim.post("/api/cua/resume", {"generation": view["generation"]})


# ── The person's viewer (only with --viewer-basic) ─────────────────────────────────────────────


def https(method, path, headers, body=b""):
    connection = http.client.HTTPSConnection(SITE, 443, timeout=30, context=ssl.create_default_context())
    connection.request(method, path, body=body, headers=headers)
    response = connection.getresponse()
    data = response.read()
    connection.close()
    return response, data


def fields(message):
    """Length-delimited fields of a protobuf message: number → bytes (enough for OpenMediaResponse)."""
    found, index = {}, 0
    while index < len(message):
        key, shift = 0, 0
        while True:
            byte = message[index]
            index += 1
            key |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                break
        number, wire = key >> 3, key & 7
        if wire == 0:
            while message[index] & 0x80:
                index += 1
            index += 1
        elif wire == 2:
            length, shift = 0, 0
            while True:
                byte = message[index]
                index += 1
                length |= (byte & 0x7F) << shift
                shift += 7
                if not byte & 0x80:
                    break
            found[number] = message[index : index + length]
            index += length
        else:
            raise ValueError("unexpected wire type")
    return found


def open_media(basic, viewer_ticket):
    """The viewer's OpenMedia through Caddy: (grpc-status, media ticket or None, ws_path or None)."""
    target = b"\x0a\x07primary"  # MediaTarget{display_id: "primary"}
    request = b"\x0a" + bytes([len(target)]) + target
    response, data = https(
        "POST",
        "/cua.env.v1.StreamService/OpenMedia",
        {
            "Authorization": "Basic " + basic,
            "Origin": "https://" + SITE,
            "Content-Type": "application/grpc-web+proto",
            "X-Grpc-Web": "1",
            "X-Cua-Env-Authorization": "Bearer " + viewer_ticket,
        },
        b"\0" + len(request).to_bytes(4, "big") + request,
    )
    status = response.getheader("grpc-status")
    message, index = None, 0
    while index + 5 <= len(data):
        length = int.from_bytes(data[index + 1 : index + 5], "big")
        chunk = data[index + 5 : index + 5 + length]
        if data[index] & 0x80:
            found = re.search(rb"grpc-status:\s*(\d+)", chunk)
            status = found.group(1).decode() if found else status
        else:
            message = chunk
        index += 5 + length
    if response.status != 200 or status != "0" or message is None:
        return status or "http-%d" % response.status, None, None
    answer = fields(message)
    return "0", answer.get(2, b"").decode(), answer.get(4, b"").decode()


def attach_media(basic, ws_path):
    """An attached media WebSocket (/media?ticket=…), as the viewer's: the open socket, or None."""
    raw = socket.create_connection((SITE, 443), timeout=15)
    connection = ssl.create_default_context().wrap_socket(raw, server_hostname=SITE)
    key = base64.b64encode(os.urandom(16)).decode()
    connection.sendall(
        (
            "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\nOrigin: https://%s\r\nAuthorization: Basic %s\r\n\r\n" % (ws_path, SITE, key, SITE, basic)
        ).encode()
    )
    head = b""
    while b"\r\n\r\n" not in head:
        chunk = connection.recv(4096)
        if not chunk:
            return None
        head += chunk
    if not head.startswith(b"HTTP/1.1 101"):
        connection.close()
        return None
    return connection


def closed_within(connection, seconds):
    """Whether the server closes the socket (a close frame, or the end of the stream) within `seconds`; media frames are read and dropped."""
    deadline = time.monotonic() + seconds
    buffered = b""
    while time.monotonic() < deadline:
        connection.settimeout(max(0.1, deadline - time.monotonic()))
        try:
            chunk = connection.recv(65536)
        except (TimeoutError, socket.timeout):
            return False
        except OSError:
            return True
        if not chunk:
            return True
        buffered += chunk
        while len(buffered) >= 2:
            opcode, length, index = buffered[0] & 0x0F, buffered[1] & 0x7F, 2
            if length == 126:
                if len(buffered) < 4:
                    break
                length, index = int.from_bytes(buffered[2:4], "big"), 4
            elif length == 127:
                if len(buffered) < 10:
                    break
                length, index = int.from_bytes(buffered[2:10], "big"), 10
            if len(buffered) < index + length:
                break
            if opcode == 0x8:
                return True
            buffered = buffered[index + length :]
    return False


# ── The run ────────────────────────────────────────────────────────────────────────────────────


def run(args):
    owner = Pim(args.pim, args.user).sign_in()
    try:
        return checks(args, owner)
    finally:
        # Whatever happened, the agents end paused and the evaluation off for this account.
        if owner.get("/api/cua").get("enabled"):
            pause(owner, timeout=120)
            owner.request("DELETE", "/api/cua")


def checks(args, owner):
    # This run's own files, so nothing an earlier run left counts.
    run_id = "e2e-%d" % int(time.time())
    other = Pim(args.pim, args.user + "-other").sign_in()
    view = owner.get("/api/cua")
    if not view.get("offered"):
        raise SystemExit("the preview doesn't offer the Cua evaluation to %s: set CUA_EVAL_OWNER to `e2e.py owner`'s answer in .dev.vars and restart it" % args.user)
    basic = None
    if args.viewer_basic:
        with open(args.viewer_basic, encoding="utf-8") as handle:
            login = handle.read().strip()
        basic = base64.b64encode(login.encode()).decode()
        secrets.extend([login, login.partition(":")[2], basic])

    print("— who may change it")
    report(other.get("/api/cua") == {"offered": False}, "another account isn't offered it, and sees nothing of it", json.dumps(other.get("/api/cua")))
    for path in ("/api/cua", "/api/cua/pause", "/api/cua/resume", "/api/cua/viewer"):
        status = other.post(path, {"generation": 1})[0]
        report(status in (403, 404), "another account can't POST %s" % path, str(status))
    report(owner.post("/api/cua/viewer", origin="https://evil.example")[0] == 403, "another site can't ask for a viewer with the owner's cookie")
    report(owner.post("/api/cua/pause", origin=None)[0] == 403, "a request without an Origin can't pause")
    status, token, _ = owner.post("/auth/tokens", {"name": "cua-e2e"})
    if status in (200, 201) and token and token.get("token"):
        secrets.append(token["token"])
        report(owner.post("/api/cua/resume", {"generation": 1}, origin=None, bearer=token["token"])[0] == 403, "an API token can't resume the agents")
        report(owner.post("/api/cua/viewer", origin=None, bearer=token["token"])[0] == 403, "an API token can't ask for a viewer")
    else:
        skip("API token checks", "couldn't make a token (HTTP %s)" % status)

    print("— turned on, paused")
    if view.get("enabled"):
        # Left on by an earlier run: start from off.
        pause(owner)
        owner.request("DELETE", "/api/cua")
    status, view, _ = owner.post("/api/cua")
    report(status == 200 and view["enabled"] and view["mode"] == "paused", "turning it on leaves the agents paused", json.dumps(view))
    chat = owner.post("/api/sessions", {})[1]["id"]
    text, error, _ = use_tool(owner, chat, "file_write", {"path": "/workspace/%s/too-early.txt" % run_id, "content": "x"})
    report(error and PAUSED in text, "while paused, file_write is refused and nothing is done", text[:200])
    text, error, _ = use_tool(owner, chat, "browser_open", {"url": args.browser_url})
    report(error and PAUSED in text, "while paused, browser_open (a read that navigates) is refused", text[:200])

    print("— resumed")
    stale = owner.get("/api/cua")["generation"] - 1
    report(owner.post("/api/cua/resume", {"generation": stale})[0] == 409, "resuming a stale pause is refused")
    status, view, _ = resume(owner)
    report(status == 200 and view["mode"] == "agents", "the person resumes the agents", json.dumps(view))
    text, error, _ = use_tool(owner, chat, "file_read", {"path": "/workspace/%s/too-early.txt" % run_id})
    report(error, "what was refused while paused was never written", text[:200])

    text, error, approval = use_tool(owner, chat, "shell", {"command": 'id -un; pwd; printf "%%s" "from shell" > %s-shell.txt; cat /etc/cua/spacesd.env 2>&1 | head -1' % run_id, "cwd": "/workspace"}, decide="approve")
    report(approval is not None, "shell asks the person first", "no approval")
    report(not error and "pim-agent" in text and "/home/pim-agent/pim" in text, "an approved command runs as pim-agent in its workspace", text[:300])
    report("Permission denied" in text, "the agents' user can't read spacesd's root token", text[:300])
    text, error, approval = use_tool(owner, chat, "shell", {"command": "touch %s-denied.txt" % run_id, "cwd": "/workspace"}, decide="deny")
    report(approval is not None and "denied" in text, "a denied command isn't run", text[:200])
    text, error, _ = use_tool(owner, chat, "file_read", {"path": "/workspace/%s-denied.txt" % run_id})
    report(error, "the denied command left nothing", text[:200])
    text, error, _ = use_tool(owner, chat, "file_read", {"path": "/workspace/%s-shell.txt" % run_id})
    report(not error and "from shell" in text, "file_read reads what the command wrote", text[:200])
    text, error, _ = use_tool(owner, chat, "file_write", {"path": "/workspace/%s/notes.md" % run_id, "content": "# E2E\nwritten by file_write\n"})
    report(not error, "file_write writes on the Cua computer", text[:200])
    text, error, _ = use_tool(owner, chat, "file_search", {"query": "written by file_write"})
    report(not error and "/workspace/%s/notes.md" % run_id in text, "file_search finds it", text[:200])
    text, error, _ = use_tool(owner, chat, "file_read", {"path": "/etc/passwd"})
    report(error, "file_read outside /workspace is refused", text[:200])

    print("— browser")
    text, error, _ = use_tool(owner, chat, "browser_open", {"url": args.browser_url})
    if error:
        report(all(word not in text for word in ("Traceback", "CUA_ENV_TOKEN", "Bearer")), "a driver failure comes back without internals or credentials", text[:300])
        print("      browser_open failed on this machine (%s); the browser checks below are skipped" % text[:160].replace("\n", " "))
    else:
        report("URL: " + args.browser_url.rstrip("/") in text or "Page:" in text, "browser_open reads the page", text[:200])
        text, error, _ = use_tool(owner, chat, "browser_read", {})
        report(not error and "Page:" in text, "browser_read reads it again", text[:200])
        found = re.search(r"\[(\d+) (?:link|button)", text)
        if found:
            text, error, approval = use_tool(owner, chat, "browser_click", {"ref": int(found.group(1))}, decide="approve")
            report(approval is not None and not error, "browser_click asks first, then clicks", text[:200])
        else:
            skip("browser_click", "the page has no link or button")
        found = re.search(r"\[(\d+) (?:textbox|searchbox|combobox)", text)
        if found:
            text, error, approval = use_tool(owner, chat, "browser_type", {"ref": int(found.group(1)), "text": "pim e2e"}, decide="approve")
            report(approval is not None and not error, "browser_type asks first, then types", text[:200])
        else:
            skip("browser_type", "the page has no text field")

    print("— pausing")
    queued = ask_only(owner, chat, "shell", {"command": "touch %s-queued.txt" % run_id, "cwd": "/workspace"})
    view = pause(owner)
    report(view["mode"] == "paused", "the pause completes", json.dumps(view))
    status, decided, _ = owner.post("/api/approvals/%s/approve" % queued["id"], {})
    wait_idle(owner, chat)
    page = owner.get("/api/sessions/%s/messages" % chat)
    text, error = tool_result(page["messages"], "shell", 0) or ("", False)
    report(PAUSED in text and "Nothing was done there" in text, "a command approved after the pause is refused when it would run", text[:200])
    status, view, _ = resume(owner)
    text, error, _ = use_tool(owner, chat, "file_read", {"path": "/workspace/%s-queued.txt" % run_id})
    report(error, "the command approved after the pause never ran", text[:200])

    # A pause waits for the agents' work, a command's and what it left running, without stopping it.
    text, error, _ = use_tool(owner, chat, "shell", {"command": "setsid sh -c 'sleep 12; touch %s-background.txt' > /dev/null 2>&1 < /dev/null & echo left" % run_id, "cwd": "/workspace"}, decide="approve")
    report(not error and "left" in text, "a command leaves a process running", text[:200])
    started = time.monotonic()
    view = owner.post("/api/cua/pause")[1]
    report(view["mode"] == "pausing" and view["pending"] > 0, "the pause waits for it", json.dumps(view))
    status, answer, _ = owner.post("/api/cua/viewer")
    report(status == 409, "no viewer opens while it runs", str(status))
    report(owner.post("/api/cua/resume", {"generation": view["generation"]})[0] == 409, "resuming a pause still completing is refused")
    view = pause(owner)
    report(view["mode"] == "paused" and time.monotonic() - started > 8, "the pause completes once it has ended, and nothing stopped it", json.dumps(view))

    print("— the person's viewer")
    status, viewer, headers = owner.post("/api/cua/viewer")
    url = (viewer or {}).get("url", "")
    ticket = url.partition("#ticket=")[2].partition("&")[0]
    if ticket:
        secrets.append(ticket)
    report(status == 200 and url.startswith("https://%s/viewer/#ticket=" % SITE), "the paused person gets a viewer link, its ticket in the fragment", str(status))
    report("no-store" in (headers.get("cache-control") or "") and headers.get("referrer-policy") == "no-referrer", "the link isn't cached and sends no referrer")
    if basic and ticket:
        grpc_status, media_ticket, ws_path = open_media(basic, ticket)
        report(grpc_status == "0" and bool(ws_path), "the viewer's OpenMedia, through Caddy and the bridge, opens a media session", "grpc-status %s" % grpc_status)
        if media_ticket:
            secrets.append(media_ticket)
        socket_ = attach_media(basic, ws_path) if ws_path else None
        report(socket_ is not None, "the media WebSocket attaches through Caddy")
        if socket_ is not None:
            if closed_within(socket_, 2):
                skip("closing on resume", "spacesd closed the socket by itself before the resume")
            else:
                status, view, _ = resume(owner)
                report(status == 200 and view["mode"] == "agents", "resuming closes the viewer's sessions first", json.dumps(view))
                report(closed_within(socket_, 15), "the attached media WebSocket is closed by the resume")
            socket_.close()
        if owner.get("/api/cua")["mode"] != "agents":
            resume(owner)
        grpc_status, _, _ = open_media(basic, ticket)
        report(grpc_status != "0", "the viewer's still-valid ticket opens nothing once the agents have the machine", "grpc-status %s" % grpc_status)
        pause(owner)
    else:
        skip("OpenMedia, the media WebSocket and closing it on resume", "give --viewer-basic")

    print("— turned off")
    status, view, _ = owner.request("DELETE", "/api/cua")
    report(status == 200 and not view["enabled"], "turning it off, paused, gives the space its own computer back", json.dumps(view))
    computer = owner.get("/api/computer") or {}
    report(computer.get("provider") != "cua", "the space's computer isn't the Cua one any more", json.dumps(computer)[:200])
    print("\n%d failed" % len(failures) if failures else "\nall checks passed")
    return 1 if failures else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=("owner", "run"))
    parser.add_argument("--pim", default="http://localhost:8787")
    parser.add_argument("--user", default="cua-e2e")
    parser.add_argument("--viewer-basic", help="a file holding the viewer's user:password; read, never printed")
    parser.add_argument("--browser-url", default="https://example.com/")
    args = parser.parse_args()
    if args.command == "owner":
        print(Pim(args.pim, args.user).sign_in().get("/api/account")["ownerId"])
        return 0
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
