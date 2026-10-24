"""The VM's own Caddyfile, patched by vm_patch.py, in a real Caddy: what reaches the bridge, what reaches spacesd, and what's logged.

    CADDY=/path/to/caddy python3 -m unittest deploy/cua-eval/test_caddy.py

Skipped without CADDY. Use the VM's version, 2.11.7 (pins.env at bootstrap 90ea971; sha256 of
caddy_2.11.7_linux_amd64.tar.gz 727b9170…8f84c). It runs bootstrap-90ea971/Caddyfile after
vm_patch.py, with the seams that file has for its own tests (site, ports, TLS snippet, static root,
upstream) and the VM's real global log settings, on loopback with Caddy's local CA, in front of
two recorders standing in for the bridge and spacesd. Nothing here reaches a network or a Cua machine.
"""

import base64
import http.client
import http.server
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vm_patch  # noqa: E402

CADDY = os.environ.get("CADDY")

CREDENTIAL = "pimcb_" + "Q7" * 24
PASSWORD = "person-password-" + "P" * 12
BASIC = base64.b64encode(("person:" + PASSWORD).encode()).decode()
COOKIE = "session=cookie-" + "C" * 20
QUERY = "query-secret-" + "S" * 20
TICKET = "v1." + "T" * 40
GRPC = {"Content-Type": "application/grpc-web+proto"}


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
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass  # Caddy gave up on an oversized body
        self.close_connection = True

    do_GET = do_POST


def recorder():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
    server.seen = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


@unittest.skipUnless(CADDY, "set CADDY to a caddy binary")
class CaddyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.hash = subprocess.run([CADDY, "hash-password", "--plaintext", PASSWORD], capture_output=True, text=True, check=True).stdout.strip()

    def setUp(self):
        self.base = tempfile.mkdtemp()
        with open(os.path.join(HERE, "bootstrap-90ea971", "Caddyfile"), encoding="utf-8") as handle:
            caddyfile = vm_patch.patch("caddyfile", handle.read())
        self.config = os.path.join(self.base, "Caddyfile")
        with open(self.config, "w", encoding="utf-8") as handle:
            handle.write(caddyfile)
        with open(os.path.join(self.base, "tls-internal.caddy"), "w") as handle:
            handle.write("tls internal\n")
        os.makedirs(os.path.join(self.base, "root", "viewer"))
        for name in ("index.html", "viewer.js"):
            with open(os.path.join(self.base, "root", "viewer", name), "w") as handle:
                handle.write("viewer")
        self.bridge, self.spacesd = recorder(), recorder()
        self.port = free_port()
        self.origin = "https://localhost:%d" % self.port
        env = dict(
            os.environ,
            XDG_DATA_HOME=self.base,
            XDG_CONFIG_HOME=self.base,
            CUA_EVAL_SITE="localhost:%d" % self.port,
            CUA_EVAL_TLS_SNIPPET=os.path.join(self.base, "tls-internal.caddy"),
            CUA_EVAL_STATIC_ROOT=os.path.join(self.base, "root"),
            CUA_EVAL_HTTP_PORT=str(free_port()),
            CUA_EVAL_HTTPS_PORT=str(self.port),
            CUA_EVAL_UPSTREAM="127.0.0.1:%d" % self.spacesd.server_address[1],
            CUA_EVAL_BASIC_USER="person",
            CUA_EVAL_BASIC_HASH=self.hash,
            PIM_BRIDGE_UPSTREAM="127.0.0.1:%d" % self.bridge.server_address[1],
            PIM_BRIDGE_CADDY_DIR=os.path.join(HERE, "caddy"),
        )
        self.log_path = os.path.join(self.base, "caddy.log")
        self.log = open(self.log_path, "wb")
        self.caddy = subprocess.Popen([CADDY, "run", "--config", self.config, "--adapter", "caddyfile"], env=env, stdout=self.log, stderr=self.log)
        deadline = time.monotonic() + 15
        while True:
            try:
                self.send("GET", "/viewer/")
                break
            except OSError:
                if time.monotonic() > deadline or self.caddy.poll() is not None:
                    raise
                time.sleep(0.2)

    def tearDown(self):
        self.caddy.terminate()
        self.caddy.wait()
        self.log.close()
        for server in (self.bridge, self.spacesd):
            server.shutdown()
            server.server_close()
        shutil.rmtree(self.base)

    def send(self, method, path, headers=None, body=b"{}"):
        """(status, headers) of one request over HTTPS, as a browser or Pim would send it."""
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        connection = http.client.HTTPSConnection("localhost", self.port, timeout=10, context=context)
        connection.request(method, path, body=body, headers={"Content-Type": "application/json", **(headers or {})})
        response = connection.getresponse()
        response.read()
        connection.close()
        return response.status, {name.lower(): value for name, value in response.getheaders()}

    def status(self, *args, **kwargs):
        return self.send(*args, **kwargs)[0]

    def person(self, **more):
        """The person's viewer: the Basic login, same origin, its ticket."""
        return {"Authorization": "Basic " + BASIC, "Origin": self.origin, "X-Cua-Env-Authorization": "Bearer " + TICKET, **GRPC, **more}

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
            "X-Cua-Env-Authorization": "Bearer " + TICKET,
            "X-Cua-Principal-Bin": "AAAA",
            "X-Cua-Relay-Authorization": "Bearer relay",
        }

    def test_pims_machine_routes_reach_the_bridge_before_the_basic_login_with_only_its_credential(self):
        status, headers = self.send("POST", "/pim-bridge/v1/status", self.everything_a_client_could_send())
        self.assertEqual(status, 200)
        self.assertNotIn("access-control-allow-origin", headers)
        path, seen = self.bridge.seen[-1]
        self.assertEqual((path, seen.get("x-pim-bridge-authorization")), ("/pim-bridge/v1/status", "Bearer " + CREDENTIAL))
        for name in ("authorization", "cookie", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "origin", "referer", "x-cua-env-authorization", "x-cua-principal-bin", "x-cua-relay-authorization"):
            self.assertNotIn(name, seen, name)
        for route in ("call", "driver", "viewer", "pause", "resume"):
            self.assertEqual(self.status("POST", "/pim-bridge/v1/" + route, {"X-Pim-Bridge-Authorization": "Bearer " + CREDENTIAL}), 200, route)
        before = len(self.bridge.seen)
        # Without Pim's credential, in its form, nothing reaches the bridge: the Basic login is no substitute.
        self.assertEqual(self.status("POST", "/pim-bridge/v1/status"), 401)
        self.assertEqual(self.status("POST", "/pim-bridge/v1/status", {"Authorization": "Basic " + BASIC, "Origin": self.origin}), 401)
        self.assertEqual(self.status("POST", "/pim-bridge/v1/status", {"X-Pim-Bridge-Authorization": "Basic " + CREDENTIAL}), 401)
        self.assertEqual(self.status("POST", "/pim-bridge/v1/status", {"X-Pim-Bridge-Authorization": "Bearer short"}), 401)
        # Anything but the exact six goes on to the Basic login, and past it to the site's 400 or 404.
        machine = {"X-Pim-Bridge-Authorization": "Bearer " + CREDENTIAL}
        for method, path in [
            ("GET", "/pim-bridge/v1/status"),
            ("POST", "/pim-bridge/v1/status?token=" + QUERY),
            ("POST", "/pim-bridge/v1/status?"),
            ("POST", "/pim-bridge/v1/%73tatus"),
            ("POST", "/pim-bridge/v1//status"),
            ("POST", "/pim-bridge/v1/mint"),
            ("POST", "/pim-bridge/v1/media/open"),
            ("POST", "/Pim-Bridge/v1/status"),
        ]:
            self.assertEqual(self.status(method, path, machine), 401, path)
            self.assertIn(self.status(method, path, {**machine, "Authorization": "Basic " + BASIC, "Origin": self.origin}), (400, 404), path)
        self.assertEqual(self.bridge.seen[before:], [])
        self.assertEqual(self.spacesd.seen, [])
        # A body over the limit is refused. Caddy streams bodies, so the bridge may see the start of one,
        # with its Content-Length, which the bridge refuses before reading (test_pim_cua_bridge).
        self.assertEqual(self.status("POST", "/pim-bridge/v1/call", machine, b"x" * (192 * 1024 + 1)), 413)

    def test_the_viewers_open_media_reaches_the_bridge_only_after_the_basic_login_origin_and_ticket(self):
        empty = b"\0\0\0\0\0"
        self.assertEqual(self.status("POST", "/cua.env.v1.StreamService/OpenMedia", {**GRPC, "X-Cua-Env-Authorization": "Bearer " + TICKET, "Origin": self.origin}, empty), 401)
        self.assertEqual(self.status("POST", "/cua.env.v1.StreamService/OpenMedia", self.person(Origin="https://evil.example"), empty), 403)
        self.assertEqual(self.status("POST", "/cua.env.v1.StreamService/OpenMedia", {**self.person(), "X-Cua-Env-Authorization": "Bearer " + CREDENTIAL}, empty), 401)
        self.assertEqual(self.status("POST", "/cua.env.v1.StreamService/OpenMedia?ticket=" + TICKET, self.person(), empty), 404)
        self.assertEqual(self.status("GET", "/cua.env.v1.StreamService/OpenMedia", self.person(), empty), 404)
        self.assertEqual((self.bridge.seen, self.spacesd.seen), ([], []))
        status, headers = self.send("POST", "/cua.env.v1.StreamService/OpenMedia", self.person(Cookie=COOKIE, **{"X-Cua-Principal-Bin": "AAAA", "X-Forwarded-For": "198.51.100.9"}), empty)
        self.assertEqual(status, 200)
        # The site's own response headers, and no CORS.
        self.assertIn("frame-ancestors 'none'", headers["content-security-policy"])
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertNotIn("access-control-allow-origin", headers)
        path, seen = self.bridge.seen[-1]
        self.assertEqual((path, seen.get("x-cua-env-authorization")), ("/pim-bridge/v1/media/open", "Bearer " + TICKET))
        for name in ("authorization", "cookie", "origin", "x-cua-principal-bin", "x-forwarded-for", "x-pim-bridge-authorization"):
            self.assertNotIn(name, seen, name)
        self.assertEqual(self.spacesd.seen, [])
        # The viewer's ten other RPCs and its media socket still go to spacesd, as before.
        self.assertEqual(self.status("POST", "/cua.env.v1.StreamService/ListTargets", self.person(), empty), 200)
        self.assertEqual(self.status("POST", "/cua.env.v1.StreamService/CloseMedia", self.person(), empty), 200)
        self.assertEqual(self.status("GET", "/media?ticket=" + TICKET, {"Authorization": "Basic " + BASIC, "Origin": self.origin}), 200)
        self.assertEqual([path for path, _ in self.spacesd.seen], ["/cua.env.v1.StreamService/ListTargets", "/cua.env.v1.StreamService/CloseMedia", "/media?ticket=" + TICKET])
        self.assertEqual(len(self.bridge.seen), 1)
        # And the root token's paths stay closed, Basic login or not.
        for path in ("/cua.env.v1.SystemService/CreateViewerTicket", "/cua.env.v1.ProcessService/StartProcess", "/mcp"):
            self.assertEqual(self.status("POST", path, self.person(), empty), 404, path)

    def test_no_log_keeps_a_credential_a_login_a_ticket_or_a_query_even_when_the_bridge_is_down(self):
        everything = self.everything_a_client_could_send()
        self.send("POST", "/pim-bridge/v1/status", everything)
        self.send("POST", "/pim-bridge/v1/status?token=" + QUERY, everything)
        self.send("GET", "/viewer/?ticket=" + QUERY, {"Authorization": "Basic " + BASIC})
        self.send("POST", "/cua.env.v1.StreamService/OpenMedia", self.person(), b"\0\0\0\0\0")
        # The bridge and spacesd stop: Caddy's proxy fails, and logs each failure with its request.
        for server in (self.bridge, self.spacesd):
            server.shutdown()
            server.server_close()
        self.assertEqual(self.status("POST", "/pim-bridge/v1/status", everything), 502)
        self.assertEqual(self.status("POST", "/cua.env.v1.StreamService/OpenMedia", self.person(Cookie=COOKIE), b"\0\0\0\0\0"), 502)
        self.assertEqual(self.status("GET", "/media?ticket=" + TICKET, {"Authorization": "Basic " + BASIC, "Origin": self.origin}), 502)
        time.sleep(0.5)
        with open(self.log_path, encoding="utf-8") as handle:
            logged = handle.read()
        entries = [json.loads(line) for line in logged.splitlines() if line.startswith("{")]
        # The failures are logged…
        failures = [entry for entry in entries if entry.get("logger", "").startswith("http.log.error")]
        self.assertGreaterEqual(len(failures), 3, logged[-2000:])
        # …without their requests, and no log keeps a secret.
        self.assertTrue(all("request" not in entry for entry in failures))
        for secret in (CREDENTIAL, BASIC, PASSWORD, "cookie-" + "C" * 20, QUERY, TICKET):
            self.assertNotIn(secret, logged, secret[:12])


if __name__ == "__main__":
    unittest.main()
