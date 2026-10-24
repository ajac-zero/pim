#!/usr/bin/env python3
"""What goes to the Cua evaluation VM: SHA256SUMS, and one script that unpacks exactly those files there.

    python3 deploy/cua-eval/make_bundle.py sums              # rewrites SHA256SUMS
    python3 deploy/cua-eval/make_bundle.py script > out.sh   # a script for Azure RunCommand

The script carries a gzipped tar of the files in SHA256SUMS (made the same way every time: fixed
owners, times and order), unpacks it into /root/pim-cua-bridge-<first 12 of SHA256SUMS' SHA-256>
and checks every file against SHA256SUMS there. It runs nothing else: install.sh is a second,
separate run. Standard library only.
"""

import base64
import gzip
import hashlib
import io
import os
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = [
    "install.sh",
    "rollback.sh",
    "vm_patch.py",
    "pim_cua_bridge.py",
    "pim-cua-bridge.service",
    "pim-agent-exec.socket",
    "pim-agent-exec.service",
    "caddy/pim-bridge-machine.caddy",
    "caddy/pim-bridge-media.caddy",
    "caddy/pim-bridge-strip.caddy",
    "bootstrap-90ea971/Caddyfile",
    "bootstrap-90ea971/deadline-check.sh",
]


def read(name):
    with open(os.path.join(HERE, name), "rb") as handle:
        return handle.read()


def sums():
    return "".join("%s  %s\n" % (hashlib.sha256(read(name)).hexdigest(), name) for name in FILES)


def bundle():
    """The gzipped tar of SHA256SUMS and FILES, the same bytes for the same files."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for name, data in [("SHA256SUMS", sums().encode())] + [(name, read(name)) for name in FILES]:
            info = tarfile.TarInfo(name)
            info.size, info.mtime, info.uid, info.gid, info.uname, info.gname = len(data), 0, 0, 0, "root", "root"
            info.mode = 0o755 if name.endswith((".sh", ".py")) else 0o644
            tar.addfile(info, io.BytesIO(data))
    packed = io.BytesIO()
    with gzip.GzipFile(fileobj=packed, mode="wb", mtime=0) as handle:
        handle.write(raw.getvalue())
    return packed.getvalue()


def script():
    digest = hashlib.sha256(sums().encode()).hexdigest()
    encoded = base64.encodebytes(bundle()).decode()
    return (
        "#!/usr/bin/env bash\n"
        "# Unpacks pim-cua-bridge's reviewed files on the Cua evaluation VM, and runs nothing else.\n"
        "# SHA256SUMS SHA-256: %s\n"
        "set -euo pipefail\n"
        "umask 077\n"
        "dest=/root/pim-cua-bridge-%s\n"
        '[ ! -e "$dest" ] || { echo "$dest exists already"; exit 1; }\n'
        'install -d -m 0700 "$dest"\n'
        "base64 -d <<'BUNDLE' | tar -xz --no-same-owner -C \"$dest\"\n%sBUNDLE\n"
        'echo "%s  $dest/SHA256SUMS" | sha256sum --quiet --strict -c -\n'
        '(cd "$dest" && sha256sum --quiet --strict -c SHA256SUMS)\n'
        'echo "unpacked and checked: $dest (SHA256SUMS %s)"\n'
    ) % (digest, digest[:12], encoded, digest, digest)


def main(argv):
    if argv[1:] == ["sums"]:
        with open(os.path.join(HERE, "SHA256SUMS"), "w") as handle:
            handle.write(sums())
        return 0
    if argv[1:] == ["script"]:
        sys.stdout.write(script())
        return 0
    print(__doc__.strip().splitlines()[2], file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
