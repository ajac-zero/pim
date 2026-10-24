#!/usr/bin/env python3
"""The two changes pim-cua-bridge's installer makes to the Cua evaluation VM's own files, and nothing else.

    python3 vm_patch.py caddyfile IN OUT    # /opt/cua-evaluation/bootstrap/proxy/Caddyfile
    python3 vm_patch.py deadline IN OUT     # /opt/cua-evaluation/bootstrap/bin/deadline-check.sh
    python3 vm_patch.py hashes              # the SHA-256 of each file before and after
    python3 vm_patch.py deadline-left       # seconds before the soft deadline, as deadline-check.sh counts them
    python3 vm_patch.py runner-properties UNIT   # the unit's sandbox settings, one per line, for systemd-run -p

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
import os
import re
import sys
import time

#: deadline-check.sh's inputs: its state folder, and the operator's config it gets CUA_EVAL_* from.
STATE_DIR = "/var/lib/cua-evaluation"
CONFIG = "/etc/cua-evaluation/config.env"


def trusted(path):
    """Whether only root can have written `path`: a regular file owned by root, writable by no one else."""
    info = os.lstat(path)
    return info.st_uid == 0 and os.path.isfile(path) and not os.path.islink(path) and not info.st_mode & 0o022


def deadline_left(root="", now=None):
    """Seconds before the soft deadline, counted as the reviewed deadline-check.sh does: from the EARLIER of the
    first-bootstrap epoch and CUA_EVAL_CREATED_EPOCH, plus CUA_EVAL_DEADLINE_HOURS (48). The config is read as
    KEY=VALUE lines, never run; an input that is missing, untrusted, unreadable or not a whole number raises ValueError."""
    config = {}
    path = root + CONFIG
    if os.path.lexists(path):
        if not trusted(path):
            raise ValueError("%s isn't a root-owned file only root may write" % CONFIG)
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                found = re.fullmatch(r"(?:export\s+)?([A-Z_][A-Z0-9_]*)=(['\"]?)([^'\"]*)\2", line)
                if not found:
                    raise ValueError("%s has a line that isn't KEY=VALUE" % CONFIG)
                key, value = found.group(1), found.group(3)
                if key.startswith("CUA_EVAL_") and key in config:
                    raise ValueError("%s sets %s twice" % (CONFIG, key))
                config[key] = value
    if config.get("CUA_EVAL_STATE_DIR", STATE_DIR) != STATE_DIR:
        raise ValueError("%s moves CUA_EVAL_STATE_DIR, which the installer doesn't follow" % CONFIG)
    hours = config.get("CUA_EVAL_DEADLINE_HOURS", "48")
    created = config.get("CUA_EVAL_CREATED_EPOCH", "")
    epoch_file = root + STATE_DIR + "/bootstrap-epoch"
    if not os.path.lexists(epoch_file) or not trusted(epoch_file):
        raise ValueError("no root-owned %s/bootstrap-epoch: the deadline isn't running" % STATE_DIR)
    with open(epoch_file, encoding="utf-8") as handle:
        start = handle.read().strip()
    for name, value in (("bootstrap-epoch", start), ("CUA_EVAL_DEADLINE_HOURS", hours), ("CUA_EVAL_CREATED_EPOCH", created or "0")):
        if not re.fullmatch(r"[0-9]{1,12}", value):
            raise ValueError("%s isn't a whole number" % name)
    begin = min(int(start), int(created)) if created else int(start)
    return begin + int(hours) * 3600 - int(time.time() if now is None else now)

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


#: Settings of the runner's unit that are about starting it, not about what confines it.
NOT_SANDBOX = {"Type", "ExecStart", "Restart", "RestartSec", "Environment"}


def runner_properties(text):
    """Every confining setting in the [Service] section of the reviewed pim-agent-exec.service, so the installer's
    trial runs under exactly those, not a copy that could drift."""
    section, found = None, []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("["):
            section = line
        elif section == "[Service]" and line and not line.startswith("#"):
            key = line.split("=", 1)[0]
            if "=" not in line or not re.fullmatch(r"[A-Za-z]+", key):
                raise ValueError("unexpected line in the runner's unit: %r" % line)
            if key not in NOT_SANDBOX:
                found.append(line)
    return found


def main(argv):
    if len(argv) == 3 and argv[1] == "runner-properties":
        with open(argv[2], encoding="utf-8") as handle:
            print("\n".join(runner_properties(handle.read())))
        return 0
    if argv[1:] == ["deadline-left"]:
        try:
            print(deadline_left())
        except (OSError, ValueError) as error:
            print("vm_patch: %s" % error, file=sys.stderr)
            return 1
        return 0
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
