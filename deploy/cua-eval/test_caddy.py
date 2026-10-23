"""Runs a real Caddy with pim-bridge's routes and log filters (caddy/), and checks what passes and what's logged.

    CADDY=/path/to/caddy python3 -m unittest deploy/cua-eval/test_caddy.py

Skipped without CADDY. It starts Caddy on loopback with caddy/Caddyfile.test, a stand-in for the
Cua VM's site, in front of two recorders standing in for the bridge and spacesd. Nothing here
reaches a network or a Cua machine.
"""

import base64
import http.client
import http.server
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CADDY = os.environ.get("CADDY")

CREDENTIAL = "pimcb_" + "Q7" * 24
BASIC = base64.b64encode(b"person:person-password").decode()
COOKIE = "session=cookie-" + "C" * 20
QUERY = "query-secret-" + "S" * 20
TICKET = "v1." + "T" * 40


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class Recorder(http.server.BaseHTTPRequestHandler):
    """Answers every request, keeping its path and headers."""

    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.server.seen.append((self.path, {name.lower(): value for name, value in self.headers.items()}))
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    do_GET = do_POST


def recorder():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
    server.seen = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@unittest.skipUnless(CADDY, "set CADDY to a caddy binary")
class CaddyTest(unittest.TestCase):
    def setUp(self):
        self.logs = tempfile.mkdtemp()
        self.bridge, self.spacesd = recorder(), recorder()
        self.port = free_port()
        env = dict(
            os.environ,
            PIM_TEST_LOGS=self.logs,
            PIM_TEST_PORT=str(self.port),
            PIM_TEST_SPACESD="127.0.0.1:%d" % self.spacesd.server_address[1],
            PIM_BRIDGE_UPSTREAM="127.0.0.1:%d" % self.bridge.server_address[1],
        )
        self.caddy = subprocess.Popen([CADDY, "run", "--config", os.path.join(HERE, "caddy", "Caddyfile.test"), "--adapter", "caddyfile"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while True:
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=0.2).close()
                break
            except OSError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.1)

    def tearDown(self):
        self.caddy.terminate()
        self.caddy.wait()
        for server in (self.bridge, self.spacesd):
            server.shutdown()
            server.server_close()
        shutil.rmtree(self.logs)

    def send(self, method, path, headers=None, body=b"{}"):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.request(method, path, body=body, headers={"Content-Type": "application/json", **(headers or {})})
        response = connection.getresponse()
        response.read()
        connection.close()
        return response.status

    def everything_a_client_could_send(self):
        return {
            "X-Pim-Bridge-Authorization": "Bearer " + CREDENTIAL,
            "Authorization": "Basic " + BASIC,
            "Cookie": COOKIE,
            "Forwarded": "for=198.51.100.9",
            "X-Forwarded-For": "198.51.100.9",
            "X-Forwarded-Host": "evil.example",
            "X-Forwarded-Proto": "http",
            "X-Real-IP": "198.51.100.9",
            "Origin": "https://evil.example",
            "Referer": "https://evil.example/page",
        }

    def test_only_the_bridge_routes_reach_it_with_only_what_it_needs(self):
        self.assertEqual(self.send("POST", "/pim-bridge/v1/status", self.everything_a_client_could_send()), 200)
        path, headers = self.bridge.seen[-1]
        self.assertEqual(path, "/pim-bridge/v1/status")
        self.assertEqual(headers.get("x-pim-bridge-authorization"), "Bearer " + CREDENTIAL)
        for name in ("authorization", "cookie", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "origin", "referer"):
            self.assertNotIn(name, headers, name)
        # Nothing else gets through to it: other methods, other paths, queries.
        before = len(self.bridge.seen)
        self.assertEqual(self.send("GET", "/pim-bridge/v1/status"), 404)
        self.assertEqual(self.send("POST", "/pim-bridge/v1/mint"), 404)
        self.assertEqual(self.send("POST", "/pim-bridge/v1/media/open"), 404)
        self.assertEqual(self.send("POST", "/pim-bridge/v1/status?token=" + QUERY), 404)
        self.assertEqual(self.bridge.seen[before:], [])
        # A body over the limit is refused. Caddy streams bodies, so the bridge may see the start of
        # one, with its Content-Length, which the bridge refuses before reading (test_pim_cua_bridge).
        self.assertEqual(self.send("POST", "/pim-bridge/v1/call", body=b"x" * (192 * 1024 + 1)), 413)

    def test_the_viewers_open_media_goes_to_the_bridge_with_its_ticket(self):
        headers = {"Content-Type": "application/grpc-web+proto", "x-cua-env-authorization": "Bearer " + TICKET, "Authorization": "Basic " + BASIC}
        self.assertEqual(self.send("POST", "/cua.env.v1.StreamService/OpenMedia", headers, b"\0\0\0\0\0"), 200)
        path, seen = self.bridge.seen[-1]
        self.assertEqual((path, seen.get("x-cua-env-authorization")), ("/pim-bridge/v1/media/open", "Bearer " + TICKET))
        self.assertNotIn("authorization", seen)
        self.assertEqual(self.spacesd.seen, [])
        # The viewer's other calls still go to spacesd.
        self.assertEqual(self.send("POST", "/cua.env.v1.StreamService/ListTargets", headers, b"\0\0\0\0\0"), 200)
        self.assertEqual(self.spacesd.seen[-1][0], "/cua.env.v1.StreamService/ListTargets")

    def test_no_log_keeps_a_credential_a_ticket_or_a_query_even_when_the_bridge_is_down(self):
        everything = self.everything_a_client_could_send()
        self.send("POST", "/pim-bridge/v1/status", everything)
        self.send("POST", "/pim-bridge/v1/status?token=" + QUERY, everything)
        self.send("GET", "/viewer/?ticket=" + QUERY, {"Authorization": "Basic " + BASIC})
        self.send("POST", "/cua.env.v1.StreamService/OpenMedia", {"Content-Type": "application/grpc-web+proto", "x-cua-env-authorization": "Bearer " + TICKET}, b"\0\0\0\0\0")
        # The bridge stops: Caddy's proxy fails, and logs the failure with the request.
        self.bridge.shutdown()
        self.bridge.server_close()
        self.assertEqual(self.send("POST", "/pim-bridge/v1/status", everything), 502)
        self.assertEqual(self.send("POST", "/cua.env.v1.StreamService/OpenMedia", {"Content-Type": "application/grpc-web+proto", "x-cua-env-authorization": "Bearer " + TICKET}, b"\0\0\0\0\0"), 502)
        time.sleep(0.5)
        logged = ""
        for name in os.listdir(self.logs):
            with open(os.path.join(self.logs, name), encoding="utf-8") as handle:
                logged += handle.read()
        entries = [json.loads(line) for line in logged.splitlines() if line.strip()]
        # The logs are there, and say what failed…
        self.assertTrue(any(entry.get("logger", "").startswith("http.log.error") for entry in entries), "no error log")
        self.assertTrue(any(entry.get("status") == 502 for entry in entries if entry.get("logger", "").startswith("http.log.access")), "no access log of the failure")
        # …and none of them keeps a secret.
        for secret in (CREDENTIAL, BASIC, "cookie-" + "C" * 20, QUERY, TICKET, "person-password"):
            self.assertNotIn(secret, logged, secret[:12])


if __name__ == "__main__":
    unittest.main()
