"""Tests for pim_cua_bridge.py, against a stand-in spacesd that runs its processes here.

Run with `python3 -m unittest deploy/cua-eval/test_pim_cua_bridge.py` (or `pnpm test:cua-bridge`).
Nothing here reaches a network or a Cua machine. The protocol-buffer bytes below were made by the
official protobuf library from cua.env.v1 at Cua commit fca21937 (process.proto, system.proto),
so they check this bridge's hand-written encoder and decoder against the real schema.
"""

import hashlib
import http.client
import http.server
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pim_cua_bridge as bridge  # noqa: E402

CREDENTIAL = "pimcb_" + "a1B2" * 12
ROOT_TOKEN = "spacesd-root-" + "z9" * 16

# CreateViewerTicketRequest{ttl{seconds:300}, policy:ALLOW_ACTIVATION, principal{id:"pim-owner", display_name:"Pim owner", kind:HUMAN}}
VIEWER_REQUEST = "0a0308ac02100332180a0970696d2d6f776e6572120950696d206f776e65722001"
# StartProcessResponse{event{end{exit_code:-3, signal:SIGNAL_TERM, timed_out:true}}}
END_EVENT = "0a111a0f08fdffffffffffffffff01100f1801"
# StartProcessResponse{event{data{offset:300, stderr:"warn\n"}}}
DATA_EVENT = "0a0c120a08ac021a057761726e0a"


def frame(message, flags=0):
    return bytes([flags]) + len(message).to_bytes(4, "big") + message


class FakeSpacesd(http.server.BaseHTTPRequestHandler):
    """gRPC-Web StartProcess (run here, as this user), CreateViewerTicket, /mcp and /health, checking the root token."""

    protocol_version = "HTTP/1.1"
    calls = []
    users = []
    mcp_answer = None
    fail_with = None

    def log_message(self, *_args):
        pass

    def reply(self, status, body=b"", content_type="application/grpc-web+proto", headers=()):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply(204 if self.path == "/health" else 404)

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        FakeSpacesd.calls.append(self.path)
        if self.headers.get("x-cua-env-authorization") != "Bearer " + ROOT_TOKEN:
            return self.reply(200, b"", headers=[("grpc-status", "16")])
        if FakeSpacesd.fail_with:
            return self.reply(500, FakeSpacesd.fail_with.encode(), "text/plain")
        if self.path == "/mcp":
            return self.mcp(json.loads(body))
        message = bytes(body[5:])
        if self.path == "/cua.env.v1.SystemService/CreateViewerTicket":
            assert message.hex() == VIEWER_REQUEST
            answer = bridge.field_string(1, "T" * 24) + bridge.field_bytes(2, bridge.field_varint(1, 1_793_000_000)) + bridge.field_string(3, "/viewer/#ticket=" + "T" * 24)
            return self.reply(200, frame(answer) + frame(b"grpc-status:0\r\n", 0x80))
        if self.path == "/cua.env.v1.ProcessService/StartProcess":
            return self.start_process(message)
        self.reply(200, b"", headers=[("grpc-status", "12")])

    def start_process(self, message):
        request = bridge.parse(message)
        config = bridge.parse(bridge.last(request, 1))
        command = [bridge.last(config, 1).decode()] + [arg.decode() for arg in config.get(2, [])]
        env = {}
        for entry in config.get(3, []):
            pair = bridge.parse(entry)
            env[bridge.last(pair, 1).decode()] = bridge.last(pair, 2).decode()
        FakeSpacesd.users.append(bridge.last(config, 5).decode())
        timeout = bridge.last(bridge.parse(bridge.last(config, 6)), 1)
        env["PATH"] = os.environ["PATH"]
        env["HOME"] = os.environ.get("HOME", "/tmp")
        try:
            done = subprocess.run(command, env=env, cwd=bridge.last(config, 4).decode(), capture_output=True, timeout=timeout)
            data = frame(bridge.field_bytes(1, bridge.field_bytes(2, bridge.field_bytes(2, done.stdout)))) if done.stdout else b""
            if done.stderr:
                data += frame(bridge.field_bytes(1, bridge.field_bytes(2, bridge.field_bytes(3, done.stderr))))
            end = bridge.varint(8) + bridge.varint(done.returncode) if done.returncode >= 0 else bridge.field_varint(2, -done.returncode)
        except subprocess.TimeoutExpired:
            data, end = b"", bridge.field_varint(2, 15) + bridge.field_varint(3, 1)
        start = frame(bridge.field_bytes(1, bridge.field_bytes(1, bridge.field_varint(1, 4242))))
        self.reply(200, start + data + frame(bridge.field_bytes(1, bridge.field_bytes(3, end))) + frame(b"grpc-status:0\r\n", 0x80))

    def mcp(self, request):
        if request.get("method") == "initialize":
            return self.reply(200, json.dumps({"jsonrpc": "2.0", "id": 0, "result": {}}).encode(), "application/json", [("mcp-session-id", "s-1")])
        if self.headers.get("mcp-session-id") != "s-1" or self.headers.get("x-cua-agent-session") != "pim-cua-bridge":
            return self.reply(404, b"", "application/json")
        if "id" not in request:
            return self.reply(202, b"", "application/json")
        answer = FakeSpacesd.mcp_answer or {"content": [{"type": "text", "text": "ok"}], "structuredContent": {"echo": request["params"]}}
        self.reply(200, json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": answer}).encode(), "application/json")


class BridgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeSpacesd)
        threading.Thread(target=cls.fake.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.fake.shutdown()

    def setUp(self):
        self.base = tempfile.mkdtemp()
        self.root = os.path.join(self.base, "home", "pim")
        os.makedirs(self.root)
        env_file = os.path.join(self.base, "spacesd.env")
        with open(env_file, "w") as handle:
            handle.write("# spacesd\nCUA_ENV_TOKEN=%s\n" % ROOT_TOKEN)
        self.config = bridge.load_config(
            {
                "PIM_BRIDGE_LISTEN": "127.0.0.1:0",
                "PIM_BRIDGE_TOKEN_SHA256": hashlib.sha256(CREDENTIAL.encode()).hexdigest(),
                "PIM_BRIDGE_RUN_AS": "cua",
                "PIM_BRIDGE_ROOT": self.root,
                "PIM_BRIDGE_SPACESD_ENV": env_file,
                "PIM_BRIDGE_PYTHON": sys.executable,
            }
        )
        self.server = bridge.serve(self.config, bridge.Spacesd(ROOT_TOKEN, self.fake.server_address))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.log = io.StringIO()
        self.redirect = redirect_stderr(self.log)
        self.redirect.__enter__()
        FakeSpacesd.calls, FakeSpacesd.users, FakeSpacesd.mcp_answer, FakeSpacesd.fail_with = [], [], None, None

    def tearDown(self):
        self.redirect.__exit__(None, None, None)
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.base)
        # Neither secret ever reaches the log.
        self.assertNotIn(CREDENTIAL, self.log.getvalue())
        self.assertNotIn(ROOT_TOKEN, self.log.getvalue())

    def request(self, route, body=None, token=CREDENTIAL, method="POST", headers=None, raw=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=30)
        data = raw if raw is not None else json.dumps(body if body is not None else {}).encode()
        sent = {"Content-Type": "application/json", "Content-Length": str(len(data))}
        if token is not None:
            sent[bridge.AUTH_HEADER] = "Bearer " + token
        sent.update(headers or {})
        connection.request(method, bridge.PREFIX + route, body=data, headers=sent)
        response = connection.getresponse()
        answer = json.loads(response.read() or b"null")
        connection.close()
        return response.status, answer

    def call(self, op, **args):
        status, answer = self.request("call", {"op": op, "args": args})
        self.assertEqual(status, 200, answer)
        return answer

    # ── Settings ──

    def test_refuses_to_start_without_sound_settings(self):
        good = {
            "PIM_BRIDGE_TOKEN_SHA256": "ab" * 32,
            "PIM_BRIDGE_RUN_AS": "cua",
            "PIM_BRIDGE_ROOT": "/home/cua/pim",
            "PIM_BRIDGE_SPACESD_ENV": os.path.join(self.base, "spacesd.env"),
        }
        bridge.load_config(good)
        for change, said in [
            ({"PIM_BRIDGE_LISTEN": "0.0.0.0:3290"}, "loopback"),
            ({"PIM_BRIDGE_LISTEN": "10.0.0.4:3290"}, "loopback"),
            ({"PIM_BRIDGE_TOKEN_SHA256": "short"}, "SHA-256"),
            ({"PIM_BRIDGE_TOKEN_SHA256": ""}, "SHA-256"),
            ({"PIM_BRIDGE_RUN_AS": "root"}, "not root"),
            ({"PIM_BRIDGE_ROOT": "/"}, "PIM_BRIDGE_ROOT"),
            ({"PIM_BRIDGE_ROOT": "/home"}, "PIM_BRIDGE_ROOT"),
            ({"PIM_BRIDGE_SPACESD_ENV": "/nonexistent/spacesd.env"}, "spacesd env file"),
        ]:
            with self.assertRaises(SystemExit) as refused:
                bridge.load_config({**good, **change})
            self.assertIn(said, str(refused.exception))
            self.assertNotIn(ROOT_TOKEN, str(refused.exception))

    # ── Protocol buffers ──

    def test_encodes_and_decodes_what_the_real_schema_does(self):
        self.assertEqual(bridge.viewer_ticket_request().hex(), VIEWER_REQUEST)
        end = bridge.parse(bridge.last(bridge.parse(bridge.last(bridge.parse(bytes.fromhex(END_EVENT)), 1)), 3))
        self.assertEqual((bridge.int32(bridge.last(end, 1)), bridge.last(end, 2), bridge.last(end, 3)), (-3, 15, 1))
        data = bridge.parse(bridge.last(bridge.parse(bridge.last(bridge.parse(bytes.fromhex(DATA_EVENT)), 1)), 2))
        self.assertEqual((bridge.last(data, 1), bridge.last(data, 3)), (300, b"warn\n"))

    # ── Who may call, and how ──

    def test_only_its_own_credential_opens_it(self):
        self.assertEqual(self.request("status", token=None)[0], 401)
        self.assertEqual(self.request("status", token=CREDENTIAL[:-1] + "x")[0], 401)
        self.assertEqual(self.request("status", token=None, headers={bridge.AUTH_HEADER: "Basic " + CREDENTIAL})[0], 401)
        # The root token is spacesd's, not a credential for the bridge.
        self.assertEqual(self.request("status", token=ROOT_TOKEN)[0], 401)
        self.assertEqual(self.request("status", token=None, headers={"Authorization": "Bearer " + CREDENTIAL})[0], 401)
        status, answer = self.request("status")
        self.assertEqual((status, answer), (200, {"ok": True, "inflight": 0, "version": bridge.VERSION}))

    def test_too_many_failures_lock_everyone_out_for_a_while(self):
        for _ in range(bridge.AUTH_FAILURES[0]):
            self.assertEqual(self.request("status", token="wrong")[0], 401)
        self.assertEqual(self.request("status")[0], 429)

    def test_takes_only_exact_routes_methods_and_small_json(self):
        self.assertEqual(self.request("status", method="GET")[0], 405)
        self.assertEqual(self.request("mint")[0], 404)
        self.assertEqual(self.request("status?x=1")[0], 404)
        self.assertEqual(self.request("call/../status")[0], 404)
        self.assertEqual(self.request("status", raw=b"x" * (bridge.MAX_BODY + 1))[0], 413)
        self.assertEqual(self.request("status", headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("call", raw=b"[1]")[0], 400)
        self.assertEqual(self.request("call", {"op": "chmod", "args": {"path": "/workspace"}})[0], 400)
        self.assertEqual(self.request("call", {"op": "stat", "args": {"path": "/workspace", "follow": True}})[0], 400)
        self.assertEqual(self.request("call", {"op": "read", "args": {"path": "/workspace/a", "length": 10**9}})[0], 400)
        self.assertEqual(self.request("call", {"op": "stat", "args": {"path": "/etc/passwd"}})[0], 400)
        # Nothing reached spacesd.
        self.assertEqual(FakeSpacesd.calls, [])

    # ── Files and commands ──

    def test_keeps_files_under_the_root_as_the_desktop_user(self):
        payload = bridge.base64.b64encode(b"# Lisbon\nFlight TP 202\n").decode()
        self.assertEqual(self.call("mkdir", path="/workspace/trips", recursive=True), {"result": None})
        self.assertEqual(self.call("write", path="/workspace/trips/lisbon.md", data=payload), {"result": None})
        self.assertEqual(FakeSpacesd.users, ["cua", "cua"])
        with open(os.path.join(self.root, "trips", "lisbon.md")) as handle:
            self.assertEqual(handle.read(), "# Lisbon\nFlight TP 202\n")
        read = self.call("read", path="/workspace/trips/lisbon.md", offset=2, length=6)["result"]
        self.assertEqual((bridge.base64.b64decode(read["data"]), read["size"]), (b"Lisbon", 23))
        stat = self.call("stat", path="/workspace/trips/lisbon.md")["result"]
        self.assertEqual((stat["size"], stat["isFile"], stat["isDirectory"], stat["name"]), (23, True, False, "lisbon.md"))
        listed = self.call("readdir", path="/workspace")["result"]
        self.assertEqual([(entry["name"], entry["isDirectory"], entry["parentPath"]) for entry in listed], [("trips", True, "/workspace")])
        self.assertEqual(self.call("find", path="/workspace", pattern="**/*.md")["result"], [{"path": "/workspace/trips/lisbon.md", "type": "file"}])
        matches = self.call("grep", query="tp 202", path="/workspace", ignoreCase=True)["result"]
        self.assertEqual([(match["path"], match["line"]) for match in matches], [("/workspace/trips/lisbon.md", 2)])
        self.assertEqual(self.call("rename", **{"from": "/workspace/trips/lisbon.md", "to": "/workspace/lisbon.md"}), {"result": None})
        self.assertEqual(self.call("rm", path="/workspace/trips", recursive=True), {"result": None})
        self.assertEqual(sorted(os.listdir(self.root)), ["lisbon.md"])
        missing = self.call("read", path="/workspace/nowhere.txt")
        self.assertEqual(missing["error"]["code"], "ENOENT")
        self.assertEqual(self.call("rm", path="/workspace")["error"]["code"], "EPERM")

    def test_links_and_dot_dots_dont_lead_out_of_the_root(self):
        outside = os.path.join(self.base, "outside")
        os.makedirs(outside)
        with open(os.path.join(outside, "secret.txt"), "w") as handle:
            handle.write("secret")
        os.symlink(outside, os.path.join(self.root, "escape"))
        self.assertEqual(self.call("read", path="/workspace/escape/secret.txt")["error"]["code"], "EACCES")
        planted = self.call("write", path="/workspace/escape/planted.txt", data="eA==")
        self.assertEqual(planted["error"]["code"], "EACCES")
        self.assertFalse(os.path.exists(os.path.join(outside, "planted.txt")))
        self.assertEqual(self.call("stat", path="/workspace/../etc/passwd")["error"]["code"], "EACCES")
        self.assertEqual(self.call("exec", command="pwd", cwd="/workspace/escape")["error"]["code"], "EACCES")
        self.assertEqual(self.call("exec", command="pwd", cwd="/workspace/..")["error"]["code"], "EACCES")

    def test_runs_commands_in_the_root_with_their_output_and_exit_code(self):
        ran = self.call("exec", command='echo "in $PWD for $PIM_WORKSPACE"; echo warn >&2; exit 3', timeoutMs=20_000, maxBytes=64_000)["result"]
        real = os.path.realpath(self.root)
        self.assertEqual(ran, {"exitCode": 3, "signal": None, "stdout": "in %s for %s\n" % (real, real), "stderr": "warn\n", "timedOut": False, "truncated": False})
        cut = self.call("exec", command="head -c 5000 /dev/zero | tr '\\0' a", maxBytes=100)["result"]
        self.assertTrue(cut["truncated"])
        self.assertIn("[… output cut …]", cut["stdout"])
        # The command never sees the request it came in.
        self.assertEqual(self.call("exec", command='echo "${PIM_FSOP_REQUEST:-none}"')["result"]["stdout"], "none\n")

    def test_no_viewer_ticket_while_an_agent_call_is_under_way(self):
        started = threading.Thread(target=lambda: self.call("exec", command="sleep 1.5"))
        started.start()
        time.sleep(0.5)
        status, answer = self.request("viewer")
        self.assertEqual((status, answer["error"]["code"]), (409, "busy"))
        self.assertEqual(self.request("status")[1]["inflight"], 1)
        started.join()
        status, answer = self.request("viewer")
        self.assertEqual((status, answer), (200, {"viewerPath": "/viewer/#ticket=" + "T" * 24, "expiresAt": 1_793_000_000}))

    # ── The browser ──

    def test_calls_only_the_driver_tools_it_knows_in_their_fixed_shapes(self):
        for tool, arguments in [
            ("launch_app", {"name": "xterm"}),
            ("page", {"action": "execute_javascript"}),
            ("browser_prepare", {"session": "pim", "allow_launch": True, "strategy": {"kind": "existing_profile"}, "profile": {"mode": "isolated_named", "name": "pim"}}),
            ("browser_prepare", {"session": "pim", "allow_launch": True, "profile": {"mode": "isolated_named", "name": "work"}}),
            ("get_browser_state", {"session": "other", "target_id": "t", "tab_id": "a"}),
            ("browser_navigate", {"session": "pim", "target_id": "t", "tab_id": "a", "url": "file:///etc/passwd"}),
            ("browser_click", {"session": "pim", "target_id": "t", "tab_id": "a", "ref": "p1:2", "input_route": "dom_event"}),
            ("browser_type", {"session": "pim", "target_id": "t", "tab_id": "a", "ref": "p1:2", "text": "x" * 2001}),
        ]:
            status, _ = self.request("driver", {"tool": tool, "arguments": arguments})
            self.assertIn(status, (400, 413), tool)
        self.assertEqual(FakeSpacesd.calls, [])
        arguments = {"session": "pim", "target_id": "t", "tab_id": "a", "url": "https://example.com/"}
        status, answer = self.request("driver", {"tool": "browser_navigate", "arguments": arguments})
        self.assertEqual((status, answer), (200, {"structured": {"echo": {"name": "browser_navigate", "arguments": arguments}}, "text": "ok", "image": None, "isError": False}))
        self.assertEqual(FakeSpacesd.calls, ["/mcp", "/mcp", "/mcp"])

    # ── Failures ──

    def test_failures_upstream_say_nothing_of_what_came_back(self):
        FakeSpacesd.fail_with = "boom " + ROOT_TOKEN
        status, answer = self.request("call", {"op": "stat", "args": {"path": "/workspace"}})
        self.assertEqual((status, answer["error"]["message"]), (502, "The Cua computer refused the call (HTTP 500)."))
        status, answer = self.request("viewer")
        self.assertEqual(status, 502)
        self.assertNotIn(ROOT_TOKEN, json.dumps(answer))
        FakeSpacesd.fail_with = None
        unauthenticated = bridge.Bridge(self.config, bridge.Spacesd("wrong-root-token-xxxx", self.fake.server_address))
        with self.assertRaises(bridge.Refusal) as refused:
            unauthenticated.dispatch("viewer", {})
        self.assertEqual(str(refused.exception), "The Cua computer refused the call (unauthenticated).")


if __name__ == "__main__":
    unittest.main()
