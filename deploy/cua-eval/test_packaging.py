"""What goes to the VM, and the two patches of the VM's own files: `python3 -m unittest deploy/cua-eval/test_packaging.py`.

Nothing here reaches a network or a machine. The installer itself is rehearsed on a disposable machine
(rehearsal/orb-vm.sh), since it needs root and systemd.
"""

import os
import re
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_bundle  # noqa: E402
import vm_patch  # noqa: E402


def read(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as handle:
        return handle.read()


class PackagingTest(unittest.TestCase):
    def test_sha256sums_is_what_would_go_to_the_vm(self):
        self.assertEqual(read("SHA256SUMS"), make_bundle.sums(), "run `python3 deploy/cua-eval/make_bundle.py sums`")
        # The same files make the same bundle, so a reviewer can rebuild it and compare.
        self.assertEqual(make_bundle.bundle(), make_bundle.bundle())

    def test_rollback_restores_exactly_the_originals_vm_patch_takes(self):
        rollback = read("rollback.sh")
        self.assertIn("CADDY_ORIGINAL=" + vm_patch.ORIGINAL["caddyfile"], rollback)
        self.assertIn("DEADLINE_ORIGINAL=" + vm_patch.ORIGINAL["deadline"], rollback)

    def test_the_caddyfile_patch_routes_open_media_to_the_bridge_after_the_persons_checks(self):
        patched = vm_patch.patch("caddyfile", vm_patch.original_text("caddyfile"))
        route = patched[patched.index("\troute {") :]
        order = [route.index(marker) for marker in ("pim-bridge-machine.caddy", "basic_auth", "@odd_path", "@bad_origin", "@no_ticket_header expression", "pim-bridge-media.caddy", "handle @viewer_rpc")]
        self.assertEqual(order, sorted(order))
        self.assertNotIn("StreamService/OpenMedia", patched)
        self.assertEqual(len(re.findall(r'^\t\t\t"/cua\.env\.v1\.', patched, re.M)), 10)
        self.assertIn("request delete", patched)
        # Only the reviewed file, byte for byte.
        with self.assertRaises(ValueError):
            vm_patch.patch("caddyfile", vm_patch.original_text("caddyfile") + "\n")
        with self.assertRaises(ValueError):
            vm_patch.patch("caddyfile", patched)

    def test_the_deadline_stops_the_bridge_and_the_runner_after_the_proxy_and_before_spacesd(self):
        patched = vm_patch.patch("deadline", vm_patch.original_text("deadline"))
        units = re.search(r"^for unit in (.*); do$", patched, re.M).group(1).split()
        self.assertEqual(units[:3], ["cua-viewer-proxy", "pim-cua-bridge", "pim-agent-exec"])
        self.assertLess(units.index("pim-agent-exec"), units.index("cua-spacesd"))
        self.assertIn('"$SYSTEMCTL" stop pim-agent-exec.socket || true', patched)
        # And every new unit stays down past the deadline, even started by hand.
        for unit in ("pim-cua-bridge.service", "pim-agent-exec.socket", "pim-agent-exec.service"):
            self.assertIn("ConditionPathExists=!/var/lib/cua-evaluation/expired", read(unit), unit)

    def test_the_patched_deadline_check_stops_them_in_that_order(self):
        with tempfile.TemporaryDirectory() as state:
            script = os.path.join(state, "deadline-check.sh")
            with open(script, "w", encoding="utf-8") as handle:
                handle.write(vm_patch.patch("deadline", vm_patch.original_text("deadline")))
            with open(os.path.join(state, "bootstrap-epoch"), "w") as handle:
                handle.write("1000")
            ran = subprocess.run(
                ["bash", script],
                env={"PATH": os.environ["PATH"], "CUA_EVAL_STATE_DIR": state, "CUA_EVAL_NOW": str(1000 + 49 * 3600), "CUA_EVAL_SYSTEMCTL": "echo"},
                capture_output=True,
                text=True,
                check=True,
            )
            stopped = [line.split()[1] for line in ran.stdout.splitlines() if line.startswith("stop ")]
            self.assertEqual(stopped[:3], ["cua-viewer-proxy.service", "pim-cua-bridge.service", "pim-agent-exec.service"])
            self.assertEqual(stopped[-1], "pim-agent-exec.socket")
            self.assertTrue(os.path.exists(os.path.join(state, "expired")))

    def rollback(self, stuck="", fail_stop="", cgroup="", listening="", backup_ok=True, caddy_rc=0, installed=True):
        """rollback.sh in a scratch root with stand-in systemctl, ss, id and caddy; returns (exit code, systemctl calls, root)."""
        fs = tempfile.mkdtemp()
        self.addCleanup(subprocess.run, ["rm", "-rf", fs])
        bin_, state = os.path.join(fs, "fakebin"), os.path.join(fs, "fakestate")
        for folder in (bin_, state, "opt/cua-evaluation/bootstrap/proxy", "opt/cua-evaluation/bootstrap/bin", "var/backups/pim-cua-bridge",
                       "usr/local/bin", "etc/cua-evaluation/credentials", "etc/systemd/system", "opt/pim-cua-bridge", "sys/fs/cgroup/system.slice"):
            os.makedirs(os.path.join(fs, folder), exist_ok=True)

        def put(path, text, mode=0o644):
            with open(os.path.join(fs, path), "w", encoding="utf-8") as handle:
                handle.write(text)
            os.chmod(os.path.join(fs, path), mode)

        for kind, live, backup in (("caddyfile", "opt/cua-evaluation/bootstrap/proxy/Caddyfile", "Caddyfile.orig"),
                                   ("deadline", "opt/cua-evaluation/bootstrap/bin/deadline-check.sh", "deadline-check.sh.orig")):
            original = vm_patch.original_text(kind)
            put(live, vm_patch.patch(kind, original) if installed else original)
            put("var/backups/pim-cua-bridge/" + backup, original if backup_ok else original + "#")
        put("etc/cua-evaluation/credentials/viewer-basic", "viewer:$2a$hash\n", 0o600)
        put("usr/local/bin/caddy", "#!/bin/sh\nexit %d\n" % caddy_rc, 0o755)
        put("fakebin/id", "#!/bin/sh\necho 0\n", 0o755)
        put("fakebin/ss", "#!/bin/sh\nprintf %s \"$FAKE_LISTENING\"\n", 0o755)
        put("fakebin/systemctl", """#!/bin/bash
echo "$*" >>"$FAKE_STATE/log"
case "$1" in
  stop) [[ " $FAKE_FAIL_STOP " == *" $2 "* ]] && exit 1; rm -f "$FAKE_STATE/$2" ;;
  start|restart) touch "$FAKE_STATE/$2" ;;
  is-active) [ -e "$FAKE_STATE/$3" ] || [[ " $FAKE_STUCK " == *" $3 "* ]] || exit 3 ;;
esac
exit 0
""", 0o755)
        units = ("pim-cua-bridge.service", "pim-agent-exec.socket", "pim-agent-exec.service")
        for unit in ("cua-viewer-proxy.service", "cua-spacesd.service") + (units if installed else ()):
            put("fakestate/" + unit, "")
        if installed:
            for unit in units:
                put("etc/systemd/system/" + unit, "")
        if cgroup:
            os.makedirs(os.path.join(fs, "sys/fs/cgroup/system.slice", cgroup))
            put("sys/fs/cgroup/system.slice/%s/cgroup.procs" % cgroup, "4242\n")
        ran = subprocess.run(["bash", os.path.join(HERE, "rollback.sh")], capture_output=True, text=True,
                             env={"PATH": bin_ + ":" + os.environ["PATH"], "PIM_ROLLBACK_FS": fs, "FAKE_STATE": state, "FAKE_STUCK": stuck,
                                  "FAKE_FAIL_STOP": fail_stop, "FAKE_LISTENING": listening})
        with open(os.path.join(state, "log")) as handle:
            return ran.returncode, handle.read().splitlines(), fs

    def test_rollback_reopens_the_viewer_only_once_everything_is_verifiably_back(self):
        code, calls, fs = self.rollback()
        self.assertEqual(code, 0)
        self.assertLess(calls.index("restart cua-spacesd.service"), calls.index("start cua-viewer-proxy.service"))
        self.assertFalse(os.path.exists(os.path.join(fs, "opt/pim-cua-bridge")))
        with open(os.path.join(fs, "opt/cua-evaluation/bootstrap/proxy/Caddyfile"), encoding="utf-8") as handle:
            self.assertEqual(vm_patch.sha256(handle.read()), vm_patch.ORIGINAL["caddyfile"])
        # After a partial install (nothing of the bridge's, originals untouched) it succeeds too.
        self.assertEqual(self.rollback(installed=False, backup_ok=False)[0], 0)

    def test_rollback_keeps_the_viewer_down_and_the_evidence_when_anything_is_ambiguous(self):
        for name, faults in [
            ("the viewer route won't stop", {"stuck": "cua-viewer-proxy.service"}),
            ("the runner won't stop", {"fail_stop": "pim-agent-exec.service", "stuck": "pim-agent-exec.service"}),
            ("a process stays in the runner's cgroup", {"cgroup": "pim-agent-exec.service"}),
            ("something listens on 3290", {"listening": "LISTEN 0 5 127.0.0.1:3290"}),
            ("the backup isn't the original", {"backup_ok": False}),
            ("caddy refuses the restored Caddyfile", {"caddy_rc": 1}),
        ]:
            with self.subTest(name):
                code, calls, fs = self.rollback(**faults)
                self.assertEqual(code, 1)
                self.assertNotIn("start cua-viewer-proxy.service", calls)
                self.assertNotIn("restart cua-spacesd.service", calls)
                self.assertTrue(os.path.isdir(os.path.join(fs, "var/backups/pim-cua-bridge")))
                if "stuck" in faults or "cgroup" in faults or "listening" in faults:
                    self.assertTrue(os.path.exists(os.path.join(fs, "opt/pim-cua-bridge")))

    def test_the_e2e_run_accepts_only_when_every_required_check_ran_and_passed(self):
        import contextlib
        import io
        import socket

        import e2e

        def verdict(passed, skipped=(), failed=(), partial=False):
            e2e.passed[:], e2e.skipped[:], e2e.failures[:] = list(passed), list(skipped), list(failed)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = e2e.verdict(partial)
            return code, out.getvalue()

        everything = list(e2e.REQUIRED)
        self.assertEqual(verdict(everything)[0], 0)
        for partial in (False, True):
            code, said = verdict(everything[1:], partial=partial)
            self.assertEqual(code, 2 if partial else 1)
            self.assertIn("INCOMPLETE", said)
            self.assertNotIn("ACCEPTED", said)
            code, said = verdict(everything, skipped=["browser_type"], partial=partial)
            self.assertNotEqual(code, 0)
            self.assertNotIn("ACCEPTED", said)
        self.assertEqual(verdict(everything, failed=["x"], partial=True)[0], 1)
        # A media socket counts as alive only if it answers a ping and stays open.
        import threading

        def pong(peer):
            frame = peer.recv(64)
            mask, payload = frame[2:6], frame[6:]
            peer.sendall(bytes([0x8A, len(payload)]) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

        ours, theirs = socket.socketpair()
        threading.Thread(target=pong, args=(theirs,)).start()
        self.assertTrue(e2e.alive(ours, 0.5))
        ours.close(), theirs.close()
        ours, theirs = socket.socketpair()
        theirs.close()
        self.assertFalse(e2e.alive(ours, 0.3))
        ours.close()

    def test_the_scripts_parse(self):
        for script in ("install.sh", "rollback.sh", "rehearsal/orb-vm.sh"):
            subprocess.run(["bash", "-n", os.path.join(HERE, script)], check=True)


if __name__ == "__main__":
    unittest.main()
