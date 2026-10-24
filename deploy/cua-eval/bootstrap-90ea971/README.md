# The Cua evaluation VM's own files, as reviewed

Exact copies of two files of the VM's bootstrap, from the `ajac-zero/Sandbox` project, branch `review/linus-cua-evaluation`, commit `90ea971` (`cua-evaluation/bootstrap/`), which is installed under `/opt/cua-evaluation/bootstrap/` on the VM:

| File here | On the VM | SHA-256 |
| --- | --- | --- |
| `Caddyfile` | `/opt/cua-evaluation/bootstrap/proxy/Caddyfile` | `d529536ac736facba6ef2f41fb097b51427a97f49be9d4e261642702f2e8fdf5` |
| `deadline-check.sh` | `/opt/cua-evaluation/bootstrap/bin/deadline-check.sh` | `d871bd3295425aee16e5e2d7c8b1809ca666d72ab57e5f57680ada8bac44eacc` |

`vm_patch.py` changes only these exact versions, and the installer refuses a VM whose files differ. `test_caddy.py` runs the patched `Caddyfile` itself in a real Caddy. Nothing else of the bootstrap is copied; `rehearsal/` reads the rest from a checkout of that commit.
