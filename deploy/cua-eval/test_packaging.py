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

    def test_the_scripts_parse(self):
        for script in ("install.sh", "rollback.sh", "rehearsal/orb-vm.sh"):
            subprocess.run(["bash", "-n", os.path.join(HERE, script)], check=True)


if __name__ == "__main__":
    unittest.main()
