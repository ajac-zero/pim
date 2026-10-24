"""Tests for pim_cua_bridge.py and its runner, against a stand-in spacesd.

Run with `python3 -m unittest deploy/cua-eval/test_pim_cua_bridge.py`.
Nothing here reaches a network or a Cua machine. The protocol-buffer bytes below were made by the
official protobuf library from cua.env.v1 at Cua commit fca21937; check_protocol.py checks that
they still are, and checks the bridge's messages against the compiled schema.
"""

import hashlib
import http.client
import http.server
import io
import json
import os
import shutil
import signal
import socket
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
VIEWER_TICKET = "v1." + "V" * 40

# CreateViewerTicketRequest{ttl{seconds:300}, policy:ALLOW_ACTIVATION, principal{id:"pim-owner", display_name:"Pim owner", kind:HUMAN}}
VIEWER_REQUEST = "0a0308ac02100332180a0970696d2d6f776e6572120950696d206f776e65722001"
# OpenMediaResponse{media_session_id:"ms-42", ticket:"v1.media", ws_path:"/media?ticket=v1.media"}
OPEN_MEDIA_RESPONSE = "0a056d732d3432120876312e6d6564696122162f6d656469613f7469636b65743d76312e6d65646961"


def frame(message, flags=0):
    return bytes([flags]) + len(message).to_bytes(4, "big") + message


TRAILERS = frame(b"grpc-status:0\r\n", 0x80)


class FakeSpacesd(http.server.BaseHTTPRequestHandler):
    """gRPC-Web StreamService media sessions, CreateViewerTicket, /mcp and /health. Anything else is UNIMPLEMENTED."""

    protocol_version = "HTTP/1.1"

    @classmethod
    def reset(cls):
        cls.calls = []
        cls.media = {}
        cls.media_auth = []
        cls.mcp_answer = None
        cls.mcp_delay = 0
        cls.fail_with = None
        cls.close_fails = False
        cls.mint_gate = None

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

    def grpc_error(self, code):
        self.reply(200, b"", headers=[("grpc-status", str(code))])

    def do_GET(self):
        self.reply(204 if self.path == "/health" else 404)

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        FakeSpacesd.calls.append(self.path)
        message = bytes(body[5:])
        if self.path == "/cua.env.v1.StreamService/OpenMedia":
            return self.open_media()
        if self.headers.get("x-cua-env-authorization") != "Bearer " + ROOT_TOKEN:
            return self.grpc_error(16)
        if FakeSpacesd.fail_with:
            return self.reply(500, FakeSpacesd.fail_with.encode(), "text/plain")
        if self.path == "/mcp":
            return self.mcp(json.loads(body))
        if self.path == "/cua.env.v1.SystemService/CreateViewerTicket":
            assert message.hex() == VIEWER_REQUEST
            if FakeSpacesd.mint_gate:
                FakeSpacesd.mint_gate.wait(10)
            answer = bridge.field_string(1, "T" * 24) + bridge.field_bytes(2, bridge.field_varint(1, 1_793_000_000)) + bridge.field_string(3, "/viewer/#ticket=" + "T" * 24 + "&clipboard=0")
            return self.reply(200, frame(answer) + TRAILERS)
        if self.path == "/cua.env.v1.StreamService/CloseMedia":
            if FakeSpacesd.close_fails:
                return self.grpc_error(14)
            session = bridge.last(bridge.parse(message), 1, b"").decode()
            if FakeSpacesd.media.pop(session, None) is None:
                return self.grpc_error(5)
            return self.reply(200, frame(b"") + TRAILERS)
        self.grpc_error(12)

    def open_media(self):
        # The viewer's own call: spacesd checks its viewer ticket, never the bridge's root token.
        FakeSpacesd.media_auth.append(self.headers.get("x-cua-env-authorization"))
        if self.headers.get("x-cua-env-authorization") != "Bearer " + VIEWER_TICKET:
            return self.grpc_error(16)
        session = "ms-%d" % (len(FakeSpacesd.media) + 1 + len(FakeSpacesd.calls))
        FakeSpacesd.media[session] = True
        answer = bridge.field_string(1, session) + bridge.field_string(2, "v1.media") + bridge.field_string(4, "/media?ticket=v1.media")
        self.reply(200, frame(answer) + TRAILERS)

    def mcp(self, request):
        if request.get("method") == "initialize":
            return self.reply(200, json.dumps({"jsonrpc": "2.0", "id": 0, "result": {}}).encode(), "application/json", [("mcp-session-id", "s-1")])
        if self.headers.get("mcp-session-id") != "s-1" or self.headers.get("x-cua-agent-session") != "pim-cua-bridge":
            return self.reply(404, b"", "application/json")
        if "id" not in request:
            return self.reply(202, b"", "application/json")
        time.sleep(FakeSpacesd.mcp_delay)
        answer = FakeSpacesd.mcp_answer or {"content": [{"type": "text", "text": "ok"}], "structuredContent": {"echo": request["params"]}}
        self.reply(200, json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": answer}).encode(), "application/json")


def descendants():
    """This process's descendants: what the runner's cgroup holds when the runner runs in this process."""
    parents = {}
    for name in os.listdir("/proc"):
        if name.isdigit():
            try:
                with open("/proc/%s/stat" % name) as handle:
                    parents[int(name)] = int(handle.read().rsplit(")", 1)[1].split()[1])
            except (OSError, ValueError, IndexError):
                pass
    found = []
    for pid in parents:
        ancestor = parents[pid]
        while ancestor > 1:
            if ancestor == os.getpid():
                found.append(pid)
                break
            ancestor = parents.get(ancestor, 0)
    return found


class BridgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeSpacesd)
        cls.fake.daemon_threads = True
        threading.Thread(target=cls.fake.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.fake.shutdown()
        cls.fake.server_close()

    def setUp(self):
        FakeSpacesd.reset()
        self.base = tempfile.mkdtemp()
        self.root = os.path.join(self.base, "home", "pim")
        os.makedirs(self.root)
        self.env_file = os.path.join(self.base, "spacesd.env")
        with open(self.env_file, "w") as handle:
            handle.write("# spacesd\nCUA_ENV_TOKEN=%s\n" % ROOT_TOKEN)
        self.environ = {
            "PIM_BRIDGE_LISTEN": "127.0.0.1:0",
            "PIM_BRIDGE_TOKEN_SHA256": hashlib.sha256(CREDENTIAL.encode()).hexdigest(),
            "PIM_BRIDGE_SPACESD_ENV": self.env_file,
            "PIM_BRIDGE_AGENT_SOCKET": os.path.join(self.base, "agent.sock"),
            "PIM_BRIDGE_AGENT_CGROUP": os.path.join(self.base, "cgroup"),
            "PIM_BRIDGE_STATE": os.path.join(self.base, "state.json"),
        }
        self.config = bridge.load_config(self.environ)
        self.log = io.StringIO()
        self.redirect = redirect_stderr(self.log)
        self.redirect.__enter__()
        self.start_runner()
        self.start()

    def start_runner(self):
        """The agents' runner, as pim-agent-exec.service runs it, on the socket systemd would hand it."""
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(self.config["agent_socket"])
        self.listener.listen()
        runner = bridge.Runner(os.path.realpath(self.root), descendants)
        threading.Thread(target=lambda: self.ignore_closing(runner.serve, self.listener), daemon=True).start()

    def stop_runner(self):
        self.listener.close()
        os.unlink(self.config["agent_socket"])

    @staticmethod
    def ignore_closing(serve, listener):
        try:
            serve(listener)
        except OSError:
            pass

    def start(self):
        self.server = bridge.serve(self.config, bridge.Spacesd(ROOT_TOKEN, self.fake.server_address))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def restart(self):
        self.server.shutdown()
        self.server.server_close()
        self.start()

    def tearDown(self):
        self.redirect.__exit__(None, None, None)
        self.server.shutdown()
        self.server.server_close()
        self.listener.close()
        for pid in descendants():
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        shutil.rmtree(self.base)
        # Neither secret, nor a viewer ticket, ever reaches the log.
        for secret in (CREDENTIAL, ROOT_TOKEN, VIEWER_TICKET):
            self.assertNotIn(secret, self.log.getvalue())

    def request(self, route, body=None, token=CREDENTIAL, method="POST", headers=None, raw=None, timeout=30):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=timeout)
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

    def open_media(self, ticket=VIEWER_TICKET):
        """The viewer's OpenMedia, as Caddy hands it on: (status, grpc-status, session id or None)."""
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=30)
        message = b"\x0a\x02\x0a\x00"
        connection.request("POST", bridge.MEDIA_ROUTE, body=frame(message), headers={"Content-Type": "application/grpc-web+proto", "x-cua-env-authorization": "Bearer " + ticket, "x-grpc-web": "1"})
        response = connection.getresponse()
        body = response.read()
        connection.close()
        if response.status != 200:
            return response.status, None, None
        status = response.getheader("grpc-status")
        session = None
        if body:
            ok, session = bridge.opened_media({k.lower(): v for k, v in response.getheaders()}, body)
            status = "0" if ok else status
        return response.status, status, session

    def lease(self):
        """Gives the machine to the agents, as the person resuming them in Pim does: their lease."""
        status, view = self.request("status")
        status, view = self.request("resume", {"epoch": view["epoch"]})
        self.assertEqual((status, view["mode"]), (200, "agents"), view)
        return view["epoch"]

    def pause(self, until="human", seconds=15):
        deadline = time.monotonic() + seconds
        while True:
            status, view = self.request("pause")
            self.assertEqual(status, 200, view)
            if view["mode"] == until or time.monotonic() > deadline:
                return view
            time.sleep(0.2)

    def call(self, op, lease=None, **args):
        status, answer = self.request("call", {"op": op, "args": args, "lease": lease or self.current})
        self.assertEqual(status, 200, answer)
        return answer

    # ── Settings ──

    def test_refuses_to_start_without_sound_settings(self):
        good = {"PIM_BRIDGE_TOKEN_SHA256": "ab" * 32, "PIM_BRIDGE_SPACESD_ENV": self.env_file}
        self.assertEqual(bridge.load_config(good)["agent_socket"], "/run/pim-agent-exec.sock")
        for change, said in [
            ({"PIM_BRIDGE_LISTEN": "0.0.0.0:3290"}, "loopback"),
            ({"PIM_BRIDGE_LISTEN": "10.0.0.4:3290"}, "loopback"),
            ({"PIM_BRIDGE_TOKEN_SHA256": "short"}, "SHA-256"),
            ({"PIM_BRIDGE_TOKEN_SHA256": ""}, "SHA-256"),
            ({"PIM_BRIDGE_AGENT_SOCKET": "agent.sock"}, "PIM_BRIDGE_AGENT_SOCKET"),
            ({"PIM_BRIDGE_SPACESD_ENV": "/nonexistent/spacesd.env"}, "spacesd env file"),
        ]:
            with self.assertRaises(SystemExit) as refused:
                bridge.load_config({**good, **change})
            self.assertIn(said, str(refused.exception))
            self.assertNotIn(ROOT_TOKEN, str(refused.exception))
        # Root itself counts as an administrator, whatever its groups.
        self.assertEqual(bridge.admin_groups("root"), {"root"})
        self.assertIsNone(bridge.admin_groups("no-such-user-pim"))
        # The runner starts only in its own unit, from its socket, on a root of its user's: not here.
        for environ, said in [
            ({}, "PIM_AGENT_ROOT must be an absolute folder"),
            ({"PIM_AGENT_ROOT": "/"}, "PIM_AGENT_ROOT must be an absolute folder"),
            ({"PIM_AGENT_ROOT": "/proc/1"}, "a folder the agents' user owns"),
            ({"PIM_AGENT_ROOT": self.root}, "must run in pim-agent-exec.service"),
            ({"PIM_AGENT_ROOT": self.root, "LISTEN_FDS": "1", "LISTEN_PID": "1"}, "started by pim-agent-exec.socket"),
        ]:
            with self.assertRaises(SystemExit) as refused:
                bridge.runner_main(environ)
            self.assertIn(said, str(refused.exception))
        # A state file it didn't write is refused, not taken as the person's or the agents'.
        with open(self.config["state"], "w") as handle:
            handle.write('{"mode": "agents", "epoch": "7"}')
        with self.assertRaises(SystemExit):
            bridge.State(self.config["state"])

    # ── Protocol buffers ──

    def test_encodes_and_decodes_what_the_real_schema_does(self):
        self.assertEqual(bridge.viewer_ticket_request().hex(), VIEWER_REQUEST)
        opened = frame(bytes.fromhex(OPEN_MEDIA_RESPONSE)) + TRAILERS
        self.assertEqual(bridge.opened_media({}, opened), (True, "ms-42"))
        self.assertEqual(bridge.opened_media({"grpc-status": "16"}, b""), (False, None))
        with self.assertRaises(ValueError):
            bridge.opened_media({}, opened[:-3])

    # ── Who may call, and how ──

    def test_only_its_own_credential_opens_it(self):
        self.assertEqual(self.request("status", token=None)[0], 401)
        self.assertEqual(self.request("status", token=CREDENTIAL[:-1] + "x")[0], 401)
        self.assertEqual(self.request("status", token=None, headers={bridge.AUTH_HEADER: "Basic " + CREDENTIAL})[0], 401)
        # The root token is spacesd's, not a credential for the bridge.
        self.assertEqual(self.request("status", token=ROOT_TOKEN)[0], 401)
        self.assertEqual(self.request("status", token=None, headers={"Authorization": "Bearer " + CREDENTIAL})[0], 401)
        # A viewer ticket opens only the viewer's route, and Pim's credential not that one.
        self.assertEqual(self.request("status", token=VIEWER_TICKET)[0], 401)
        status, answer = self.request("status")
        self.assertEqual((status, answer["mode"], answer["inflight"]), (200, "human", 0))

    def test_too_many_failures_lock_everyone_out_for_a_while(self):
        for _ in range(bridge.AUTH_FAILURES[0]):
            self.assertEqual(self.request("status", token="wrong")[0], 401)
        self.assertEqual(self.request("status")[0], 429)

    def test_takes_only_exact_routes_methods_and_small_json(self):
        self.current = self.lease()
        FakeSpacesd.calls = []
        self.assertEqual(self.request("status", method="GET")[0], 405)
        self.assertEqual(self.request("mint")[0], 404)
        self.assertEqual(self.request("status?x=1")[0], 404)
        self.assertEqual(self.request("call/../status")[0], 404)
        self.assertEqual(self.request("media/open")[0], 415)
        self.assertEqual(self.request("status", raw=b"x" * (bridge.MAX_BODY + 1))[0], 413)
        self.assertEqual(self.request("status", headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("call", raw=b"[1]")[0], 400)
        for op, args in [
            ("chmod", {"path": "/workspace"}),
            ("stat", {"path": "/workspace", "follow": True}),
            ("read", {"path": "/workspace/a", "length": 10**9}),
            ("stat", {"path": "/etc/passwd"}),
        ]:
            self.assertEqual(self.request("call", {"op": op, "args": args, "lease": self.current})[0], 400, op)
        # Nothing reached spacesd.
        self.assertEqual(FakeSpacesd.calls, [])

    # ── Who has the machine ──

    def test_the_agents_call_only_under_their_lease_while_the_machine_is_theirs(self):
        stat = {"op": "stat", "args": {"path": "/workspace"}}
        # It starts as the person's: nothing of the agents' runs, whatever lease they name.
        for lease in (None, 0, 1, 2):
            status, answer = self.request("call", {**stat, "lease": lease})
            self.assertEqual((status, answer["error"]["code"]), (423, "paused"))
        lease = self.lease()
        self.assertEqual(self.request("call", {**stat, "lease": lease})[0], 200)
        self.assertEqual(self.request("call", {**stat, "lease": lease - 1})[0], 423)
        self.assertEqual(self.pause()["mode"], "human")
        # A call that arrives late, from before the pause, is refused, and so is one after the next resume.
        self.assertEqual(self.request("call", {**stat, "lease": lease})[0], 423)
        newer = self.lease()
        self.assertGreater(newer, lease)
        self.assertEqual(self.request("call", {**stat, "lease": lease})[0], 423)
        self.assertEqual(self.request("driver", {"tool": "end_session", "arguments": {"session": "pim"}, "lease": lease})[0], 423)
        self.assertEqual(self.request("call", {**stat, "lease": newer})[0], 200)

    def test_resuming_needs_the_pause_the_person_saw_and_a_complete_pause(self):
        epoch = self.request("status")[1]["epoch"]
        self.assertEqual(self.request("resume", {"epoch": epoch - 1})[1]["error"]["code"], "stale")
        lease = self.request("resume", {"epoch": epoch})[1]["epoch"]
        self.assertEqual(self.request("resume", {"epoch": lease})[1]["error"]["code"], "not-paused")
        # While the agents' work finishes, resuming is refused: nothing hands the machine back half-paused.
        self.current = lease
        running = threading.Thread(target=lambda: self.call("exec", command="sleep 1.5"))
        running.start()
        time.sleep(0.5)
        draining = self.request("pause")[1]
        self.assertEqual((draining["mode"], draining["inflight"]), ("draining", 1))
        status, answer = self.request("resume", {"epoch": draining["epoch"]})
        self.assertEqual((status, answer["error"]["code"]), (409, "not-paused"))
        running.join()
        self.assertEqual(self.pause()["mode"], "human")

    def test_a_pause_waits_for_what_commands_left_running_however_they_left(self):
        self.current = self.lease()
        started = time.monotonic()
        ran = self.call("exec", command="(sleep 1.5; touch late-nohup) > /dev/null 2>&1 & setsid sh -c 'sleep 2.5; touch late-setsid' > /dev/null 2>&1 < /dev/null & echo started")["result"]
        # The command's answer comes when the shell ends, not when what it left does.
        self.assertEqual((ran["exitCode"], ran["stdout"]), (0, "started\n"))
        self.assertLess(time.monotonic() - started, 1.4)
        # The helper and everything it left: the shell's children, and what went off into a session of its own.
        view = self.request("pause")[1]
        self.assertEqual(view["mode"], "draining")
        self.assertGreaterEqual(view["background"], 4)
        self.assertEqual(self.request("viewer")[1]["error"]["code"], "busy")
        view = self.pause()
        self.assertEqual(view["mode"], "human")
        # By then even what escaped into a session of its own had done what it was going to.
        self.assertTrue(os.path.exists(os.path.join(self.root, "late-nohup")))
        self.assertTrue(os.path.exists(os.path.join(self.root, "late-setsid")))
        self.assertGreater(time.monotonic() - started, 2.4)

    def test_a_pause_waits_for_a_call_whose_caller_gave_up_waiting(self):
        lease = self.lease()
        # Pim stops waiting after a second; the driver call goes on, and so does the agents' hold on the machine.
        FakeSpacesd.mcp_delay = 2
        with self.assertRaises(OSError):
            self.request("driver", {"tool": "end_session", "arguments": {"session": "pim"}, "lease": lease}, timeout=1)
        view = self.request("pause")[1]
        self.assertEqual((view["mode"], view["inflight"]), ("draining", 1))
        self.assertEqual(self.request("viewer")[1]["error"]["code"], "busy")
        started = time.monotonic()
        self.assertEqual(self.pause()["mode"], "human")
        self.assertGreater(time.monotonic() - started, 0.5)

    def test_a_restart_keeps_who_has_the_machine_and_waits_out_what_it_forgot(self):
        lease = self.current = self.lease()
        # A command's process that the restarted bridge knows nothing of, still running in the runner's cgroup.
        self.call("exec", command="setsid sh -c 'sleep 2.5; touch late' > /dev/null 2>&1 < /dev/null &")
        bridge.QUIET_AFTER_RESTART, quiet = 1, bridge.QUIET_AFTER_RESTART
        try:
            self.restart()
            view = self.request("status")[1]
            self.assertEqual(view["mode"], "draining")
            self.assertGreater(view["epoch"], lease)
            self.assertEqual(self.request("call", {"op": "stat", "args": {"path": "/workspace"}, "lease": lease})[0], 423)
            view = self.request("pause")[1]
            self.assertEqual(view["mode"], "draining")
            self.assertEqual(self.pause()["mode"], "human")
            self.assertTrue(os.path.exists(os.path.join(self.root, "late")))
        finally:
            bridge.QUIET_AFTER_RESTART = quiet
        # And the person's state outlives a restart too.
        self.restart()
        self.assertEqual(self.request("status")[1]["mode"], "human")

    def test_a_pause_waits_while_the_runners_cgroup_holds_more_than_the_runner_whatever_it_says(self):
        self.current = self.lease()
        # The runner says nothing runs, but its cgroup, which the bridge reads itself, holds two processes.
        os.makedirs(self.config["agent_cgroup"])
        procs = os.path.join(self.config["agent_cgroup"], "cgroup.procs")
        with open(procs, "w") as handle:
            handle.write("4100\n4101\n")
        view = self.request("pause")[1]
        self.assertEqual((view["mode"], view["background"]), ("draining", 1))
        with open(procs, "w") as handle:
            handle.write("4100\n")
        self.assertEqual(self.request("pause")[1]["mode"], "human")

    def test_a_pause_stays_incomplete_while_the_runner_cant_say_what_runs(self):
        self.current = self.lease()
        self.stop_runner()
        status, answer = self.request("pause")
        self.assertEqual((status, answer["error"]["message"]), (502, "The agents' runner on the Cua computer didn't answer."))
        self.assertEqual(self.request("status")[1]["mode"], "draining")
        self.assertEqual(self.request("viewer")[1]["error"]["code"], "busy")
        self.start_runner()
        self.assertEqual(self.pause()["mode"], "human")

    # ── The person's viewer ──

    def test_the_viewer_opens_media_only_while_the_machine_is_the_persons_and_resuming_closes_it(self):
        status, ticket = self.request("viewer")
        self.assertEqual((status, ticket["viewerPath"]), (200, "/viewer/#ticket=" + "T" * 24 + "&clipboard=0"))
        _, grpc, first = self.open_media()
        _, _, second = self.open_media()
        self.assertEqual(grpc, "0")
        self.assertEqual(sorted(FakeSpacesd.media), sorted([first, second]))
        # The viewer's call reached spacesd with its own ticket only, never the root token.
        self.assertEqual(set(FakeSpacesd.media_auth), {"Bearer " + VIEWER_TICKET})
        self.assertEqual(self.open_media(ticket="v1." + "W" * 40)[1], "16")
        self.assertEqual(self.open_media(ticket=ROOT_TOKEN)[0], 401)
        self.assertEqual(self.request("status")[1]["viewerSessions"], 2)
        lease = self.lease()
        # Every one of the person's sessions was closed before the agents got the machine.
        self.assertEqual(FakeSpacesd.media, {})
        self.assertEqual(self.request("status")[1]["viewerSessions"], 0)
        # Its still-valid viewer ticket opens nothing now, and no new ticket is made.
        self.assertEqual(self.open_media()[1], "9")
        self.assertEqual(FakeSpacesd.media, {})
        self.assertEqual(self.request("viewer")[1]["error"]["code"], "busy")
        self.current = lease
        self.assertIn("result", self.call("stat", path="/workspace"))

    def test_the_agents_stay_paused_when_a_viewer_session_wont_close(self):
        self.open_media()
        FakeSpacesd.close_fails = True
        epoch = self.request("status")[1]["epoch"]
        status, answer = self.request("resume", {"epoch": epoch})
        self.assertEqual((status, answer["error"]["code"]), (502, "handoff"))
        view = self.request("status")[1]
        self.assertEqual((view["mode"], view["viewerSessions"]), ("human", 1))
        self.assertEqual(self.request("call", {"op": "stat", "args": {"path": "/workspace"}, "lease": epoch})[0], 423)
        FakeSpacesd.close_fails = False
        # A session spacesd already ended counts as closed.
        FakeSpacesd.media.clear()
        self.assertEqual(self.request("resume", {"epoch": epoch})[1]["mode"], "agents")

    def test_a_ticket_minted_as_the_agents_resume_opens_nothing(self):
        FakeSpacesd.mint_gate = threading.Event()
        minted = []
        minting = threading.Thread(target=lambda: minted.append(self.request("viewer")))
        minting.start()
        time.sleep(0.3)
        epoch = self.request("status")[1]["epoch"]
        resumed = []
        resuming = threading.Thread(target=lambda: resumed.append(self.request("resume", {"epoch": epoch})))
        resuming.start()
        time.sleep(0.3)
        # The resume waits for the ticket being made…
        self.assertEqual(resumed, [])
        FakeSpacesd.mint_gate.set()
        minting.join()
        resuming.join()
        self.assertEqual((minted[0][0], resumed[0][1]["mode"]), (200, "agents"))
        # …and the ticket then opens no media session.
        self.assertEqual(self.open_media()[1], "9")
        self.assertEqual(FakeSpacesd.media, {})

    def test_media_sessions_are_remembered_across_a_restart(self):
        _, _, session = self.open_media()
        self.restart()
        self.lease()
        self.assertNotIn(session, FakeSpacesd.media)

    # ── Files and commands ──

    def test_keeps_files_under_the_root_as_the_agents_user(self):
        self.current = self.lease()
        payload = bridge.base64.b64encode(b"# Lisbon\nFlight TP 202\n").decode()
        self.assertEqual(self.call("mkdir", path="/workspace/trips", recursive=True), {"result": None})
        self.assertEqual(self.call("write", path="/workspace/trips/lisbon.md", data=payload), {"result": None})
        # Pim passes an existing file's whole st_mode back when it rewrites it; only its permission bits count, on creation.
        self.assertEqual(self.call("write", path="/workspace/trips/lisbon.md", data=payload, mode=0o100644), {"result": None})
        # The runner ran them, not spacesd.
        self.assertEqual(FakeSpacesd.calls, [])
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
        self.current = self.lease()
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
        self.current = self.lease()
        ran = self.call("exec", command='echo "in $PWD for $PIM_WORKSPACE"; echo warn >&2; exit 3', timeoutMs=20_000, maxBytes=64_000)["result"]
        real = os.path.realpath(self.root)
        self.assertEqual(ran, {"exitCode": 3, "signal": None, "stdout": "in %s for %s\n" % (real, real), "stderr": "warn\n", "timedOut": False, "truncated": False})
        cut = self.call("exec", command="head -c 5000 /dev/zero | tr '\\0' a", maxBytes=100)["result"]
        self.assertTrue(cut["truncated"])
        self.assertIn("[… output cut …]", cut["stdout"])
        # The command never sees the request it came in.
        self.assertEqual(self.call("exec", command='echo "${PIM_FSOP_REQUEST:-none}"')["result"]["stdout"], "none\n")
        slow = self.call("exec", command="echo before; sleep 30", timeoutMs=1000)["result"]
        self.assertEqual((slow["timedOut"], slow["exitCode"], slow["signal"], slow["stdout"]), (True, None, "SIGTERM", "before\n"))
        self.assertEqual(FakeSpacesd.calls, [])

    # ── The browser ──

    def test_calls_only_the_driver_tools_it_knows_in_their_fixed_shapes(self):
        lease = self.lease()
        FakeSpacesd.calls = []
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
            status, _ = self.request("driver", {"tool": tool, "arguments": arguments, "lease": lease})
            self.assertIn(status, (400, 413), tool)
        self.assertEqual(FakeSpacesd.calls, [])
        arguments = {"session": "pim", "target_id": "t", "tab_id": "a", "url": "https://example.com/"}
        status, answer = self.request("driver", {"tool": "browser_navigate", "arguments": arguments, "lease": lease})
        self.assertEqual((status, answer), (200, {"structured": {"echo": {"name": "browser_navigate", "arguments": arguments}}, "text": "ok", "image": None, "isError": False}))
        self.assertEqual(FakeSpacesd.calls, ["/mcp", "/mcp", "/mcp"])

    # ── Failures ──

    def test_failures_upstream_say_nothing_of_what_came_back(self):
        self.current = self.lease()
        FakeSpacesd.fail_with = "boom " + ROOT_TOKEN
        status, answer = self.request("driver", {"tool": "end_session", "arguments": {"session": "pim"}, "lease": self.current})
        self.assertEqual((status, answer["error"]["message"]), (502, "The Cua driver didn't open a session."))
        self.assertNotIn(ROOT_TOKEN, json.dumps(answer))
        FakeSpacesd.fail_with = None
        unauthenticated = bridge.Spacesd("wrong-root-token-xxxx", self.fake.server_address)
        with self.assertRaises(bridge.Refusal) as refused:
            bridge.mint_viewer(unauthenticated)
        self.assertEqual(str(refused.exception), "The Cua computer refused the call (unauthenticated).")


if __name__ == "__main__":
    unittest.main()
