# A Cua evaluation's bridge token, from the VM to the preview

`computer/cua-host/eval-credentials.ts` carries one evaluation's bridge token from a new, disposable VM to the local preview that qualifies it. The token is made on the VM, in the bridge's own token file, and comes back through the cloud's management channel (Azure Run Command output) only encrypted, to a key made on the operator's machine. On that machine it is decrypted straight into the preview's private `.dev.vars`. It is evaluation tooling: nothing in Pim imports it, it adds no route, setting or secret loader, and it is not how a deployment gets its bridges (a deployment's `CUA_BRIDGES` is a Worker secret its operator sets, `docs/cua-bridge.md`).

It does not provision anything. It makes no network request, calls no cloud API, creates no account or service, and runs no other program. The Run Command script that runs `seal` on the VM, the accounts and directories it expects, and the preview fixture that reads `CUA_BRIDGES` are separate, separately reviewed steps; this page says what each must do for this channel to hold.

```
 operator's machine                                  management channel                 VM (bridge's account)
 keygen ─▶ key/eval-key.pem (0600, in 0700)
       └─▶ public key + fingerprint ─── provisioning input (not secret) ──────────────▶ seal: new token
                                                                                          ├─▶ token file (0600, bridge's 0700 dir)
 capture ◀── management response (ciphertext only) ◀── Run Command stdout ◀──────────────┘   envelope on stdout
 open ─▶ <repo>/.dev.vars (0600): CUA_BRIDGES='{"o_…":{"url":"https://…","token":"…"}}'
```

## The commands

Each is `node computer/cua-host/eval-credentials.ts <command> …`, on Node 22.18 or later. An evaluation ID is 3 to 63 lowercase letters, digits and hyphens, starting with a letter or digit; an owner ID is Pim's (`o_` and 26 lowercase letters or digits). Every path is absolute, normalized and free of links; every file is created new and never over or through anything already there. Each refuses to run as root.

- **`keygen --dir <new directory>`** (operator's machine) makes the directory (`0700`) and an RSA-3072 key pair in it: `eval-key.pem` (PKCS #8, unencrypted, `0600`) and `eval-key.pub.pem` (SPKI, `0600`). It prints `{"event":"eval-credentials.key","fingerprint":"<hex>"}`, the SHA-256 of the public key's DER SubjectPublicKeyInfo. Make one per evaluation; never reuse it.
- **`seal --evaluation <id> --owner <o_…> --public-key <file> --fingerprint <hex> --token-file <file>`** (the VM, as the bridge's account) reads the public key (a regular file of root's or this account's that no one else can write) and refuses it unless it is RSA-3072 with exponent 65537 and has the pinned fingerprint. It refuses a token file that already exists, or whose directory isn't this account's with no access for anyone else. Then it makes the token, 32 random bytes in base64url (43 characters, what bridge.ts and Pim take), encrypts it, creates the token file (`0600`, the token with no line end, as bridge.ts reads it), and only then prints the envelope as its one line of output.
- **`capture --out <file>`** (operator's machine) stores what it reads on standard input, at most 1 MiB and not empty, in a new `0600` file, in a directory of this account's that no one else can write.
- **`open --key-dir <dir> --response <file> --evaluation <id> --owner <o_…> --url <https://…> --out <file>`** (operator's machine) checks everything first, then creates `--out` (`0600`) holding exactly one line, `CUA_BRIDGES='{"<owner>":{"url":"<url>","token":"<token>"}}'`, and prints `{"event":"eval-credentials.opened","evaluation":"<id>"}`.

A failure prints only `{"event":"eval-credentials.failed","command":"<command>","reason":"<reason>"}` to standard error and exits 1; wrong arguments print the usage, repeating none of them, and exit 2. No path, token, key, or what was thrown is ever printed.

## The envelope

`seal` prints `pim-eval-credential.v1.` followed by base64url (no padding) of this JSON, with exactly these fields in this order and no whitespace:

```json
{"v":1,"alg":"RSA-OAEP-3072-SHA256","evaluation":"<id>","owner":"<o_…>","recipient":"<fingerprint>","ciphertext":"<base64url, 384 bytes>"}
```

The ciphertext is RSA-OAEP with SHA-256 (and MGF1-SHA-256), from Node's built-in `crypto` (OpenSSL); there is no other dependency and no cipher of this module's own. Its OAEP label is `pim-eval-credential.v1.\n<evaluation>\n<owner>\n<fingerprint>`, so a ciphertext decrypts only under the evaluation, owner and key it was made for. Because the envelope is base64url after a fixed prefix, it reads the same in raw script output and inside the JSON string `az vm run-command invoke` answers with, and is about 970 bytes, well under the last 4 KiB of output Run Command keeps.

`open` takes the response and, before it creates anything:

1. reads the private key and the response only as regular files of this account's that no one else can read, not through links, in trusted directories (every directory above owned by root or this account and writable by no one else unless sticky; the key's own directory with no access for anyone else);
2. finds the prefix exactly once in the whole response (none is `envelope-missing`, two are `envelope-duplicate`), takes the base64url run after it (1 to 2,048 characters), and decodes it only in its canonical form, as UTF-8;
3. takes the JSON only if re-serializing it gives the same text, which refuses a repeated or extra field, reordering and whitespace, and only with `v` 1 and the algorithm above;
4. requires `evaluation` and `owner` to be what the operator passed, and `recipient` to be the fingerprint of its own key, and the ciphertext to be exactly 384 bytes;
5. decrypts with the label built from what the operator passed, not from the envelope;
6. requires the plaintext to be a token exactly as `seal` makes them, and refuses a response that also holds that token in plaintext (`response-plaintext`): it has leaked through the management channel, and the evaluation must start again with a new VM and key;
7. requires the URL to be HTTPS in the exact form `URL` gives it, with a lowercase host name or bracketed IPv6 address, an optional port, a path of unreserved characters, and no credentials, query or fragment. That is narrower than what Pim takes, so it needs no escaping.

Then it writes the file: created with `O_CREAT | O_EXCL | O_NOFOLLOW` and mode `0600`, checked to be this account's regular `0600` file, written whole and synced. Of two `open`s at once, one creates it and the other is refused (`output-exists`). If writing fails after the file is created, the file is emptied and removed, so no part of it stays; there is no temporary file. The private key, token and file contents are held in buffers that are zeroed after use; that is best effort, since Node may have copied them and nothing here keeps memory out of swap.

## How the preview reads it

The output is the preview's `.dev.vars` in the repository root, beside `wrangler.preview.jsonc`. Wrangler 4.148, which the repository pins, reads that file with `dotenv.parse` and no variable expansion, and passes each entry to the Worker as a secret binding; its bindings table shows the value as `(hidden)`. A single-quoted dotenv value is taken as it is, and the line holds no quote, backslash, `$`, `#`, backtick or line break, because the owner, URL and token are checked to have none. So `env.CUA_BRIDGES` is exactly the JSON that `bridgeFor` (`src/cua.ts`) reads. This was checked by running Wrangler's own loader (`getPlatformProxy`) on a file `open` wrote: the Worker's `CUA_BRIDGES` was that JSON exactly. That check isn't one of the committed tests, which don't depend on Wrangler; they check the file's exact bytes and that its value parses to `{"<owner>":{"url":…,"token":…}}`.

Don't load it with `wrangler dev --env-file`: Wrangler then reads it as a `.env` file, with `$` expansion, and also puts it in its own process environment.

`open` never writes over a `.dev.vars` that is already there. If the preview has one (for traces, say), move it aside first and put those settings back after the evaluation; the tool doesn't merge files.

### What the preview fixture must do with it

The preview fixture that qualifies the bridge is separate work, on its own branch, which this one doesn't touch. For this channel to hold, it must:

- read the bridge only as Pim does, through `env.CUA_BRIDGES` and `bridgeFor`, and never copy, store, log or answer with the secret, its URL or its token;
- use as its test space the same owner ID given to `seal` and `open` (`--owner`), with the marker `{"provider":"cua","space":"<owner>"}`, so the one entry is that space's;
- add nothing that reads secret files or loads them over a route: the preview gets the secret from `.dev.vars` only, at start;
- be started (or restarted) after `open` writes `.dev.vars`, and again after it is removed.

## Running it

On the operator's machine (paths are examples; they must be absolute, with no links, in directories only this account and root can write):

```sh
H=/home/user/workspace/repo/computer/cua-host/eval-credentials.ts
EVAL=cua-eval-20261027            # new for each evaluation
OWNER=o_…                         # the preview test space's owner ID
STATE=$HOME/.local/state/pim-cua-eval
mkdir -p -m 700 "$STATE" && mkdir -m 700 "$STATE/$EVAL"
node "$H" keygen --dir "$STATE/$EVAL/key"     # prints the fingerprint
```

The provisioning input (cloud-init or the Run Command script, reviewed separately) carries `eval-key.pub.pem`'s contents, the fingerprint, `EVAL` and `OWNER`, none of which is a secret. On the VM, the reviewed script runs, as the bridge's account and with fixed arguments:

```sh
runuser -u pim-bridge -- /usr/bin/node /opt/pim/cua-host/eval-credentials.ts seal \
  --evaluation "$EVAL" --owner "$OWNER" --public-key /etc/pim-eval/eval-key.pub.pem \
  --fingerprint "$FINGERPRINT" --token-file /etc/pim-bridge/token
```

It should print nothing else to standard output, so the envelope stays in the last 4 KiB Run Command keeps. Back on the operator's machine, capture the management response straight into a new private file, and open it into the preview:

```sh
set -o pipefail
az vm run-command invoke … --command-id RunShellScript --scripts @seal.sh \
  | node "$H" capture --out "$STATE/$EVAL/response.json"
node "$H" open --key-dir "$STATE/$EVAL/key" --response "$STATE/$EVAL/response.json" \
  --evaluation "$EVAL" --owner "$OWNER" --url "https://<bridge address>/pim" \
  --out /home/user/workspace/repo/.dev.vars
```

Then restart the preview (`amp orb service stop preview`, `amp orb services ensure`) and check `amp orb service logs preview` says `Using secrets defined in .dev.vars`.

If `capture` or `open` refuses, nothing was written by it; fix what its reason names and run it again. If `seal` refused, the VM has no token file. If `seal` made the token file but its output was lost, `seal` won't run again over it: tear the VM down and start again rather than reading the token off the VM.

## What is kept where, and teardown

| Where | What | Secret? | Removed by |
| --- | --- | --- | --- |
| Operator: `$STATE/$EVAL/key/eval-key.pem` | the private key | yes: it decrypts every envelope of this evaluation | `rm -rf "$STATE/$EVAL"` at teardown |
| Operator: `$STATE/$EVAL/response.json` | Azure's response, with the envelope | ciphertext | the same |
| Operator: `<repo>/.dev.vars` | the token, in plaintext | yes | `rm` it, then restart the preview |
| Operator: Azure CLI's own logs and caches (`~/.azure`) | may record the command and its response | ciphertext at most | review and remove after the evaluation |
| Provisioning input: Azure's VM model (user data), `/var/lib/cloud` on the VM | public key, fingerprint, evaluation and owner IDs | no | deleting the VM and its resource group |
| Azure: the action Run Command's status (instance view), or a managed Run Command's `instanceView` | the last 4 KiB of the script's output: the envelope | ciphertext | for a managed one, `az vm run-command delete`; an action one's is replaced by a later one (not verified here); deleting the VM removes both |
| Azure Activity Log | that the Run Command ran, and who ran it | no output is expected there; not verified here | Azure's retention (90 days) |
| VM: `/var/lib/waagent/run-command/download/<n>/` (action) or the Run Command handler's download directory (managed) | the script, its `stdout` (the envelope) and `stderr` | ciphertext; the script holds nothing secret | deleting the VM and its disks |
| VM: `/etc/pim-bridge/token` | the token, in plaintext | yes, by design: bridge.ts reads it | deleting the VM and its disks |

Removing a file doesn't scrub the disk; on the operator's machine the token and key may stay in free blocks, journals or backups of that disk. Use a machine whose disk is encrypted, and leave the state directory and `.dev.vars` out of backups. Nothing here goes into git: `.dev.vars` is ignored, the state directory is outside the repository, and the tests make their keys and tokens in a temporary directory they remove.

## What this protects, and what it doesn't

- **Read access to the management channel learns no token.** Azure's Run Command results and history, the guest agent's copies on the VM, the operator's captured response and Azure CLI's logs all hold only the envelope. Only the private key on the operator's machine decrypts it.
- **A changed envelope is refused.** OAEP refuses a changed ciphertext, the label refuses one moved to another evaluation, owner or key, and `open` refuses fields that don't match what the operator expects before decrypting.
- **Encryption doesn't say who sent it.** The public key is public: anyone who can make the management response say something (the cloud's control plane, anyone allowed to run commands on the VM or read and change its Run Command resources, root on the VM) can encrypt a token of their own to it, and `open` would put that token in the preview. They can't redirect Pim, because the URL comes from the operator, not the envelope; with a token of their choosing in the preview, Pim would present it to the operator's bridge, which refuses it unless the bridge's own file was changed the same way, and whoever can do that already controls the VM. Provenance rests on who may run commands on the VM, which the separately reviewed Azure permissions must keep to the operator.
- **Replay is bounded, not prevented.** An envelope can be decrypted again by anyone holding the private key, and a captured one can be replayed to `open`. Because the key and the evaluation ID are new for each evaluation, an old envelope fails to decrypt for a new one; within one evaluation, `seal` runs once and the token file can't be made twice, so a replay gives back the same token, and `open` won't write a second `.dev.vars` over the first. There is no freshness nonce.
- **The pinned fingerprint** makes the VM refuse a public key other than the one the operator made, such as a stale key from an earlier evaluation or a corrupted file. It comes through the same provisioning input as the key, so it doesn't protect against whoever controls that input.
- **Out of scope:** root on the VM and the cloud's operators can read the token in the bridge's file; anyone who acts as the operator's account can read the private key and `.dev.vars`; memory is scrubbed only on a best-effort basis.

## Tests

`computer/cua-host/test/eval-credentials.test.ts` runs the commands as the program they are, as one user, over real files in a temporary directory removed at the end (the test checks it is gone), with real RSA keys and encryption, and management responses written by the test in place of Azure's:

- a token made by `seal` reaches `open`'s file through a response shaped as `az vm run-command invoke` answers and through bare output, exactly, with every file's mode and owner as above, and the token file is one bridge.ts's relay takes;
- `seal`'s output holds no form of the token (as made, base64 or hex);
- another evaluation, owner or key, rewritten fields, a flipped ciphertext byte, a ciphertext for another owner's label, decrypted plaintext that isn't a token, and a response with the token in plaintext are refused, and nothing is written;
- missing, duplicate, oversized, non-canonical, non-UTF-8 and malformed envelopes (extra, missing, repeated or reordered fields, whitespace, another version or algorithm, a short ciphertext), and responses over 1 MiB, are refused;
- unsafe key directories and files (group-readable, links, a linked directory), unsafe responses (shared, a link, a FIFO), existing outputs, links at the output's path (dangling or not), group-writable or linked output directories, relative paths, non-canonical URLs, an existing token file or a link at its path, another key's fingerprint, a group-writable or 2048-bit public key, and a token directory others can enter are refused, leaving what was there unchanged;
- six `open`s at once write the file once, and the other five are refused;
- when the process may write only 1 KiB (`prlimit`), the write fails partway and no file is left;
- every failure printed is the fixed form, and no token or path appears in anything the program printed.

Not shown by them: running as root (refused, but not tested, since the tests don't run as root); anything on a VM, through Azure, or as two accounts; the Azure CLI's real output; and the preview fixture.

### What remains to test on the VM

Before this channel is used, the separately reviewed provisioning should show, on a disposable VM: Run Command (action or managed) running the fixed `seal` command as the bridge's account through `runuser`, with that account owning a `0700` token directory; the token file readable by bridge.ts and not by the desktop user; the envelope arriving whole in the response and `open` taking it; `seal`'s refusals arriving as the fixed form; which of the retention places above actually hold the envelope, and that teardown removes them; Node 22.18 or later on the VM; that the Azure permissions allow only the operator to run commands on the VM; and the preview connecting to the bridge over TLS it trusts.
