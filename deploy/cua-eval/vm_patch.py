#!/usr/bin/env python3
"""The two changes pim-cua-bridge's installer makes to the Cua evaluation VM's own files, and nothing else.

    python3 vm_patch.py caddyfile IN OUT    # /opt/cua-evaluation/bootstrap/proxy/Caddyfile
    python3 vm_patch.py deadline IN OUT     # /opt/cua-evaluation/bootstrap/bin/deadline-check.sh
    python3 vm_patch.py hashes              # the SHA-256 of each file before and after

Each takes only the exact file reviewed at bootstrap commit 90ea971 (bootstrap-90ea971/), by its
SHA-256, finds each anchor exactly once, and writes the patched file, whose SHA-256 is fixed too.
Anything else is refused and nothing is written. Standard library only.

- Caddyfile: imports pim-bridge-machine.caddy as the first thing in the site's `route`, before
  its Basic login; takes StreamService/OpenMedia out of @viewer_rpc's 11 paths; and imports
  pim-bridge-media.caddy just before `handle @viewer_rpc`, after the Basic login, path, header,
  Origin and ticket checks. The global log filter (`request delete`) and everything else stay.
- deadline-check.sh: at the soft deadline it stops the bridge and the agents' runner too, right
  after the public proxy.
"""

import hashlib
import sys

ORIGINAL = {
    "caddyfile": "d529536ac736facba6ef2f41fb097b51427a97f49be9d4e261642702f2e8fdf5",
    "deadline": "d871bd3295425aee16e5e2d7c8b1809ca666d72ab57e5f57680ada8bac44eacc",
}

IMPORT = "import {$PIM_BRIDGE_CADDY_DIR:/opt/pim-cua-bridge/caddy}/"

EDITS = {
    "caddyfile": [
        (
            "\troute {\n\t\t# 1. Authenticate EVERY request first (HTTP Basic). The hash comes from the env.\n",
            "\troute {\n"
            "\t\t# 0. pim-cua-bridge (Pim's private Cua evaluation): Pim's six machine routes, exact, POST, no\n"
            "\t\t#    query, with Pim's own credential and not the Basic login. Added by its installer.\n"
            "\t\t" + IMPORT + "pim-bridge-machine.caddy\n"
            "\n"
            "\t\t# 1. Authenticate EVERY request first (HTTP Basic). The hash comes from the env.\n",
        ),
        ('\t\t\t"/cua.env.v1.StreamService/OpenMedia",\n', ""),
        (
            "\t\thandle @viewer_rpc {\n",
            "\t\t# pim-cua-bridge: the viewer's OpenMedia goes to the bridge, which opens media sessions only\n"
            "\t\t# while the person has the machine and records each one. Added by its installer.\n"
            "\t\t" + IMPORT + "pim-bridge-media.caddy\n"
            "\t\thandle @viewer_rpc {\n",
        ),
    ],
    "deadline": [
        (
            "for unit in cua-viewer-proxy cua-amp-runner-login cua-amp-runner cua-amp-login cua-spacesd cua-audio cua-desktop; do\n",
            "for unit in cua-viewer-proxy pim-cua-bridge pim-agent-exec cua-amp-runner-login cua-amp-runner cua-amp-login cua-spacesd cua-audio cua-desktop; do\n",
        ),
        (
            '  "$SYSTEMCTL" stop "$unit.service" || true\ndone\n',
            '  "$SYSTEMCTL" stop "$unit.service" || true\ndone\n"$SYSTEMCTL" stop pim-agent-exec.socket || true\n',
        ),
    ],
}


def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def patch(kind, text):
    """The patched file, or ValueError saying why this isn't the file reviewed."""
    if sha256(text) != ORIGINAL[kind]:
        raise ValueError("this %s is not the one reviewed (SHA-256 %s, expected %s)" % (kind, sha256(text), ORIGINAL[kind]))
    for anchor, replacement in EDITS[kind]:
        if text.count(anchor) != 1:
            raise ValueError("an anchor of the %s is not there exactly once" % kind)
        text = text.replace(anchor, replacement)
    return text


def original_text(kind):
    import os

    name = {"caddyfile": "Caddyfile", "deadline": "deadline-check.sh"}[kind]
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "bootstrap-90ea971", name), encoding="utf-8") as handle:
        return handle.read()


def main(argv):
    if argv[1:] == ["hashes"]:
        for kind in ORIGINAL:
            print("%s original %s patched %s" % (kind, ORIGINAL[kind], sha256(patch(kind, original_text(kind)))))
        return 0
    if len(argv) != 4 or argv[1] not in ORIGINAL:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    with open(argv[2], encoding="utf-8", newline="") as handle:
        text = handle.read()
    try:
        patched = patch(argv[1], text)
    except ValueError as error:
        print("vm_patch: %s; nothing written" % error, file=sys.stderr)
        return 1
    with open(argv[3], "x", encoding="utf-8", newline="") as handle:
        handle.write(patched)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
