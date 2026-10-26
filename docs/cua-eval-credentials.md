# A Cua evaluation's bridge token, from the VM to the preview

`computer/cua-host/eval-credentials.ts` carries one evaluation's bridge token from a new, disposable VM to the local preview that qualifies it. The token is made on the VM, in the bridge's own token file, and comes back through the cloud's management channel (Azure Run Command output) only encrypted, to a key made on the operator's machine. On that machine it is decrypted straight into the preview's private environment file, outside the checkout, which the preview loads with `--env-file` (the preview fixture's workflow, "Qualifying a bridge against the preview" in `docs/cua-bridge.md`). It is evaluation tooling: nothing in Pim imports it, it adds no route, setting or secret loader, and it is not how a deployment gets its bridges (a deployment's `CUA_BRIDGES` is a Worker secret its operator sets, `docs/cua-bridge.md`).

It does not provision anything. It makes no network request, calls no cloud API, creates no account or service, and runs no other program. The Run Command script that runs `seal` on the VM, the accounts and directories it expects, and the preview fixture that reads `CUA_BRIDGES` are separate, separately reviewed steps; this page says what each must do for this channel to hold.

```
 operator's machine                                  management channel                 VM (bridge's account)
 keygen ─▶ key/eval-key.pem (0600, in 0700)
       └─▶ public key + fingerprint ─── provisioning input (not secret) ──────────────▶ seal: new token
                                                                                          ├─▶ token file (0600, bridge's 0700 dir)
 capture ◀── management response (ciphertext only) ◀── Run Command stdout ◀──────────────┘   envelope on stdout
 open ─▶ ~/.config/pim-preview-cua/preview.env (0600, in 0700):
           PREVIEW_CUA_FIXTURE=seed
           PREVIEW_CUA_FIXTURE_OWNER=o_…
           CUA_BRIDGES='{"o_…":{"url":"https://…","token":"…"}}'
 pnpm preview --env-file ~/.config/pim-preview-cua/preview.env
```

## The commands

Each is `node computer/cua-host/eval-credentials.ts <command> …`, on Node 22.18 or later. An evaluation ID is 3 to 63 lowercase letters, digits and hyphens, starting with a letter or digit; an owner ID is Pim's (`o_` and 26 lowercase letters or digits). Every path is absolute, normalized and free of links; every file is created new and never over or through anything already there. Each refuses to run as root.

- **`keygen --dir <new directory>`** (operator's machine) makes the directory (`0700`) and an RSA-3072 key pair in it: `eval-key.pem` (PKCS #8, unencrypted, `0600`) and `eval-key.pub.pem` (SPKI, `0600`). It prints `{"event":"eval-credentials.key","fingerprint":"<hex>"}`, the SHA-256 of the public key's DER SubjectPublicKeyInfo. Make one per evaluation; never reuse it.
- **`seal --evaluation <id> --owner <o_…> --public-key <file> --fingerprint <hex> --token-file <file>`** (the VM, as the bridge's account) reads the public key (a regular file of root's or this account's that no one else can write) and refuses it unless it is RSA-3072 with exponent 65537 and has the pinned fingerprint. It refuses a token file that already exists, leaving it as it is, or whose directory isn't this account's with no access for anyone else. Then it makes the token, 32 random bytes in base64url (43 characters, what bridge.ts and Pim take), encrypts it, creates the token file (`0600`, the token with no line end, as bridge.ts reads it), and only then prints the envelope as its one line of output.
- **`capture --out <file>`** (operator's machine) stores what it reads on standard input, at most 1 MiB and not empty, in a new `0600` file, in a directory of this account's that no one else can write.
- **`open --key-dir <dir> --response <file> --evaluation <id> --owner <o_…> --url <https://…> --out <file> [--fixture seed]`** (operator's machine) checks everything first, then creates `--out` (`0600`), in a directory of this account's that no one else can enter (`0700`, so not the checkout), and prints `{"event":"eval-credentials.opened","evaluation":"<id>"}`. The file holds `CUA_BRIDGES='{"<owner>":{"url":"<url>","token":"<token>"}}'` as its last line; with `--fixture seed`, the preview fixture's two settings come first, `PREVIEW_CUA_FIXTURE=seed` and `PREVIEW_CUA_FIXTURE_OWNER=<owner>`, the same checked owner ID. No other value is accepted for `--fixture`, and nothing else is ever written.

A failure prints only `{"event":"eval-credentials.failed","command":"<command>","reason":"<reason>"}` to standard error and exits 1; wrong arguments print the usage, repeating none of them, and exit 2. No path, token, key, or what was thrown is ever printed.

## The envelope

`seal` prints `pim-eval-credential.v1.` followed by base64url (no padding) of this JSON, with exactly these fields in this order and no whitespace:

```json
{"v":1,"alg":"RSA-OAEP-3072-SHA256","evaluation":"<id>","owner":"<o_…>","recipient":"<fingerprint>","ciphertext":"<base64url, 384 bytes>"}
```

The ciphertext is RSA-OAEP with SHA-256 (and MGF1-SHA-256), from Node's built-in `crypto` (OpenSSL); there is no other dependency and no cipher of this module's own. Its OAEP label is `pim-eval-credential.v1.\n<evaluation>\n<owner>\n<fingerprint>`, so a ciphertext decrypts only under the evaluation, owner and key it was made for. The envelope is about 970 bytes, well under the last 4 KiB of output Run Command keeps.

`open` takes the response and, before it creates anything:

1. reads the private key and the response only as regular files of this account's that no one else can read, not through links, in trusted directories (every directory above owned by root or this account and writable by no one else unless sticky; the key's own directory with no access for anyone else);
2. finds the prefix exactly once in the whole response (none is `envelope-missing`, two are `envelope-duplicate`) and takes the base64url run after it (1 to 2,048 characters, else `envelope-size`);
3. requires the envelope to be framed as a line of its own, in bare output or inside a JSON string (`envelope-framing` otherwise): right before the prefix, the start of the response, a line feed, a JSON `\n` escape or a JSON string's opening quote; right after the run, the end of the response, a line feed (or CR LF), a JSON `\n` (or `\r\n`) escape, or a closing quote. So padding (`=`), a percent-encoding or any other text running on from it or into it is refused, while `az vm run-command invoke`'s answer, a managed Run Command's `instanceView.output`, and bare output are taken;
4. decodes the run only in its canonical base64url form, as UTF-8 (`envelope-encoding`), and takes the JSON only if re-serializing it gives the same text, which refuses a repeated or extra field, reordering and whitespace, and only with `v` 1 and the algorithm above;
5. requires `evaluation` and `owner` to be what the operator passed (`context`), `recipient` to be the fingerprint of its own key (`recipient`), and the ciphertext to be exactly 384 bytes;
6. decrypts with the label built from what the operator passed, not from the envelope (`decrypt`);
7. requires the plaintext to be a token exactly as `seal` makes them (`token`), and refuses a response that also holds that token in plaintext (`response-plaintext`): it has leaked through the management channel, and the evaluation must start again with a new VM and key;
8. requires the URL to be HTTPS in the exact form `URL` gives it, with a lowercase host name or bracketed IPv6 address, an optional port, a path of unreserved characters, and no credentials, query or fragment (`url`). That is narrower than what Pim takes, so it needs no escaping.

Then it writes the file: created with `O_CREAT | O_EXCL | O_NOFOLLOW` and mode `0600`, checked to be this account's regular `0600` file, written whole and synced. Of two `open`s at once, one creates it and the other is refused (`output-exists`). There is no temporary file. The private key, token and file contents are held in buffers that are zeroed after use; that is best effort, since Node may have copied them and nothing here keeps memory out of swap.

### When writing a file fails

Every file is written the same way, and a write that fails after the file was created is cleaned up in two separate attempts, each made only if the path is still this call's own file (same device and inode): empty it, then remove it, the second tried even if the first failed.

- **`<reason>-write`** (`output-write`, `token-write`, `response-write`, `key-write`): the file was removed. If emptying it failed, its blocks may still hold what was written, as with any removed file, but no file is left.
- **`<reason>-write-residue`**: the file could not be shown removed: the path couldn't be checked, is no longer this call's file, or wouldn't be removed. **A file may be left, possibly holding part of what was being written** (for `output-write-residue`, part of the token). Remove it yourself, and treat the evaluation as needing review.

## How the preview reads it

The preview fixture's reviewed workflow keeps the preview's secrets in a private file outside the checkout, `$HOME/.config/pim-preview-cua/preview.env` in a `0700` directory, and starts the preview with `pnpm preview --env-file <that file>`, which passes it to `wrangler dev`. `open --out <that file> --fixture seed` writes exactly that file, so no token is ever copied, pasted or printed. With Wrangler 4.148, which the repository pins:

- **The bindings are exact, and secret.** With `--env-file`, Wrangler reads only the files given, not `.dev.vars`, parses them with `dotenv` (a single-quoted value is taken as it is) and expands `$` references with `dotenv-expand`. The owner, URL and token hold no quote, backslash, `$`, `#`, backtick or line break, so expansion leaves them unchanged and `env.CUA_BRIDGES` is exactly the JSON `bridgeFor` (`src/cua.ts`) reads. Each value is bound as a secret, which Wrangler's bindings table shows as `(hidden)`. The committed test (below) checks this with Wrangler's own loader, `unstable_getVarsForDev`, the function `wrangler dev` binds `--env-file` with, on the repository's `wrangler.preview.jsonc`, and checks that what Wrangler said and its debug log hold no token. Running `wrangler dev` with such a file once, by hand, showed `env.CUA_BRIDGES ("(hidden)")` and the fixture's two settings likewise, and no token in its output or in its log files.
- **Wrangler's processes have them in their environment.** Before running any command, Wrangler loads every `--env-file` into its own `process.env`, and starts processes with that environment: workerd (Miniflare passes `process.env` through, and `/proc/<pid>/environ` of the running workerd showed `CUA_BRIDGES`) and the web app's build (`pnpm --filter pim-web build`, and Vite under it). Wrangler's own Node process holds them in memory. Anything running as the operator's account, and root, can read them there while the preview runs, so the account that runs the preview must be one only the operator uses. The Worker gets them as secret bindings, and, under `nodejs_compat`, in its own `process.env`. None of these processes sends its environment anywhere; the token leaves only as Pim's `Authorization` header to the bridge's URL, which is what it is for, and nothing of this file goes to the VM.
- **Logs name the file, not what is in it.** Wrangler says `Using secrets defined in <path>`, and writes a debug log of each run under `~/.config/.wrangler/logs/` with the same. Its local explorer (`/cdn-cgi/local/explorer/api` on the preview's port) lists the Worker's bindings without variables or secrets. Wrangler's anonymous telemetry, unless turned off (`WRANGLER_SEND_METRICS=false`), reports how it was run; set it off for the evaluation.
- **A missing file stops it at once.** Node 26 (the repository's `.nvmrc`) refuses to start Wrangler when an `--env-file` path doesn't exist (`node: <path>: not found`), before Wrangler reads anything.

The file holds only these three settings. To give the preview other settings, such as the trace exporter's (`docs/reference.md`), append them as lines of their own (`printf 'OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318\n' >> "$CFG/preview.env"`), never a `CUA_BRIDGES` or `PREVIEW_CUA_…` line, which would override the ones written; and never copy, print or merge the file.

### What the preview fixture must do with it

The preview fixture (`preview/cua-fixture.ts`, run by the preview's `Pim` constructor) is what reads the file's values. For this channel to hold, it must, and does:

- read the bridge only as Pim does, through `env.CUA_BRIDGES` and `bridgeFor`, and never copy, store, log or answer with the secret, its URL or its token (its tests check its storage and logs);
- seed only the space `PREVIEW_CUA_FIXTURE_OWNER` names, when `PREVIEW_CUA_FIXTURE` is exactly `seed`, which is the same owner given to `seal` and `open`, so the one `CUA_BRIDGES` entry is that space's; and seed it once: it never re-enables, resumes, renews or reseeds, and a space it refused, failed on or didn't finish doesn't start at all, opted in or not, rather than fall back to the default computer;
- add nothing that reads secret files or loads them over a route: the preview gets the secret from `--env-file` only, at start;
- be started with the file after `open` writes it, and stopped before the file is removed.

## Running it

On the operator's machine (paths must be absolute, with no links, in directories only this account and root can write):

```sh
H=/home/user/workspace/repo/computer/cua-host/eval-credentials.ts
EVAL=cua-eval-20261027            # new for each evaluation
OWNER=o_…                         # the preview test space's owner ID (the fixture's step 1)
STATE=$HOME/.local/state/pim-cua-eval
CFG=$HOME/.config/pim-preview-cua  # the fixture's private directory
install -d -m 0700 "$STATE" "$STATE/$EVAL" "$CFG"
node "$H" keygen --dir "$STATE/$EVAL/key"     # prints the fingerprint
```

The provisioning input (cloud-init or the Run Command script, reviewed separately) carries `eval-key.pub.pem`'s contents, the fingerprint, `EVAL` and `OWNER`, none of which is a secret. On the VM, the reviewed script runs, as the bridge's account and with fixed arguments:

```sh
runuser -u pim-bridge -- /usr/bin/node /opt/pim/cua-host/eval-credentials.ts seal \
  --evaluation "$EVAL" --owner "$OWNER" --public-key /etc/pim-eval/eval-key.pub.pem \
  --fingerprint "$FINGERPRINT" --token-file /etc/pim-bridge/token
```

It should print nothing else to standard output, so the envelope stays in the last 4 KiB Run Command keeps. Back on the operator's machine, capture the management response straight into a new private file, open it into the preview's environment file, and start the preview with it:

```sh
set -o pipefail
az vm run-command invoke … --command-id RunShellScript --scripts @seal.sh \
  | node "$H" capture --out "$STATE/$EVAL/response.json"
node "$H" open --key-dir "$STATE/$EVAL/key" --response "$STATE/$EVAL/response.json" \
  --evaluation "$EVAL" --owner "$OWNER" --url "https://<bridge address>/pim" \
  --out "$CFG/preview.env" --fixture seed
amp orb service stop preview
WRANGLER_SEND_METRICS=false pnpm preview --env-file "$CFG/preview.env"
```

Wrangler should say `Using secrets defined in …/preview.env` and list `env.CUA_BRIDGES ("(hidden)")`. Then follow the fixture's steps (`"outcome":"seeded"`).

### When something fails

- **`capture` or `open` refused** with any reason but `…-write-residue`: nothing of its own was left. Fix what the reason names and run it again; `open` won't write over a file already there, so remove a stale `preview.env` first (it holds the token).
- **`…-write-residue`**: see "When writing a file fails": remove the file yourself and review.
- **`seal` failed, or its output gave no envelope `open` takes**, fail closed. A token file may be on the VM: `token-exists` leaves one that was already there, `token-write-residue` may leave part of one, and `stdout` (the envelope couldn't be written) and a lost or truncated management response leave a whole one whose envelope never arrived. Don't read the token off the VM, don't delete it to run `seal` again, and don't run `seal` with another token path: tear the VM down, review what happened, and start again with a new key and evaluation ID.

## What is kept where, and teardown

| Where | What | Secret? | Removed by |
| --- | --- | --- | --- |
| Operator: `$STATE/$EVAL/key/eval-key.pem` | the private key | yes: it decrypts every envelope of this evaluation | `rm -rf "$STATE/$EVAL"` at teardown |
| Operator: `$STATE/$EVAL/response.json` | Azure's response, with the envelope | ciphertext | the same |
| Operator: `$CFG/preview.env` | the token, in plaintext, and the fixture's settings | yes | stop the preview, then the fixture's teardown (`rm -f "$CFG/preview.env" && rmdir "$CFG"`) |
| Operator: the running preview's processes (Wrangler, workerd, the web build) | the file's values, in their environment and memory | yes | stopping the preview |
| Operator: `~/.config/.wrangler/logs/` | each run's log: the file's path | no (no token, checked) | remove after the evaluation |
| Operator: Azure CLI's own logs and caches (`~/.azure`) | may record the command and its response | ciphertext at most | review and remove after the evaluation |
| Provisioning input: Azure's VM model (user data), `/var/lib/cloud` on the VM | public key, fingerprint, evaluation and owner IDs | no | deleting the VM and its resource group |
| Azure: the action Run Command's status (instance view), or a managed Run Command's `instanceView` | the last 4 KiB of the script's output: the envelope | ciphertext | for a managed one, `az vm run-command delete`; an action one's is replaced by a later one (not verified here); deleting the VM removes both |
| Azure Activity Log | that the Run Command ran, and who ran it | no output is expected there; not verified here | Azure's retention (90 days) |
| VM: `/var/lib/waagent/run-command/download/<n>/` (action) or the Run Command handler's download directory (managed) | the script, its `stdout` (the envelope) and `stderr` | ciphertext; the script holds nothing secret | deleting the VM and its disks |
| VM: `/etc/pim-bridge/token` | the token, in plaintext | yes, by design: bridge.ts reads it | deleting the VM and its disks |

Removing a file doesn't scrub the disk; on the operator's machine the token and key may stay in free blocks, journals or backups of that disk. Use a machine whose disk is encrypted, and leave the state and configuration directories out of backups. Nothing here goes into git: both directories are outside the repository, and the tests make their keys and tokens in a temporary directory they remove.

## What this protects, and what it doesn't

- **Read access to the management channel learns no token.** Azure's Run Command results and history, the guest agent's copies on the VM, the operator's captured response and Azure CLI's logs all hold only the envelope. Only the private key on the operator's machine decrypts it.
- **A changed envelope is refused.** OAEP refuses a changed ciphertext, the label refuses one moved to another evaluation, owner or key, and `open` refuses fields that don't match what the operator expects, or framing that isn't a line of its own, before decrypting.
- **Encryption doesn't say who sent it.** The public key is public: anyone who can make the management response say something (the cloud's control plane, anyone allowed to run commands on the VM or read and change its Run Command resources, root on the VM) can encrypt a token of their own to it, and `open` would put that token in the preview. They can't redirect Pim, because the URL comes from the operator, not the envelope; with a token of their choosing in the preview, Pim would present it to the operator's bridge, which refuses it unless the bridge's own file was changed the same way, and whoever can do that already controls the VM. Provenance rests on who may run commands on the VM, which the separately reviewed Azure permissions must keep to the operator.
- **Replay is bounded, not prevented.** An envelope can be decrypted again by anyone holding the private key, and a captured one can be replayed to `open`. Because the key and the evaluation ID are new for each evaluation, an old envelope fails to decrypt for a new one; within one evaluation, `seal` runs once and the token file can't be made twice, so a replay gives back the same token, and `open` won't write a second file over the first. There is no freshness nonce.
- **The pinned fingerprint** makes the VM refuse a public key other than the one the operator made, such as a stale key from an earlier evaluation or a corrupted file. It comes through the same provisioning input as the key, so it doesn't protect against whoever controls that input.
- **Out of scope:** root on the VM and the cloud's operators can read the token in the bridge's file; anyone who acts as the operator's account can read the private key, the preview's file and the running preview's environment; memory is scrubbed only on a best-effort basis.

## Tests

`computer/cua-host/test/eval-credentials.test.ts` runs the commands as the program they are, as one user, over real files in a temporary directory removed at the end (the test checks it is gone), with real RSA keys and encryption, and management responses written by the test in place of Azure's:

- a token made by `seal` reaches `open`'s file exactly, with the fixture's settings, through a response shaped as `az vm run-command invoke` answers, through a managed Run Command's `instanceView`, and through bare output, with every file's mode and owner as above, and the token file is one bridge.ts's relay takes;
- Wrangler's own `--env-file` loader, on the repository's `wrangler.preview.jsonc` and that file, binds exactly `CUA_BRIDGES` and the fixture's two settings, each as a secret, and nothing it said or logged (at debug level) holds the token; no server is started;
- `seal`'s output holds no form of the token (as made, base64 or hex); when the envelope can't be written, `seal` says `stdout` and the token file stays, as documented;
- another evaluation, owner or key, rewritten fields, a flipped ciphertext byte, a ciphertext for another owner's label, decrypted plaintext that isn't a token, and a response with the token in plaintext are refused, and nothing is written;
- missing, duplicate, oversized, badly framed (padding, `.`, a percent-encoding or text running on, text running into it, in bare output or a JSON string), non-canonical, non-UTF-8 and malformed envelopes (extra, missing, repeated or reordered fields, whitespace, another version or algorithm, a short ciphertext), and responses over 1 MiB, are refused;
- unsafe key directories and files (group-readable, links, a linked directory), unsafe responses (shared, a link, a FIFO), existing outputs, links at the output's path (dangling or not), output directories others can write or enter, linked output directories, relative paths, non-canonical URLs, another `--fixture` value, an existing token file or a link at its path, another key's fingerprint, a group-writable or 2048-bit public key, and a token directory others can enter are refused, leaving what was there unchanged;
- six `open`s at once write the file once, and the other five are refused;
- when the process may write only 1 KiB (`prlimit`), the write fails partway and no file is left;
- with file operations that fail on purpose: a write failing partway leaves no file (`output-write`), also when emptying it fails; when removing it fails, or the path can't be checked, the refusal is `output-write-residue` and the file is there;
- every failure printed is the fixed form, and no token or path appears in anything the program printed.

Not shown by them: running as root (each command refuses it, but no test shows that: the tests skip themselves when run as root, and otherwise can't become root); a running preview (the bindings table, workerd's environment and the absence of the token from `wrangler dev`'s output and logs were checked once by hand, not in the tests); anything on a VM, through Azure, or as two accounts; and the Azure CLI's real output.

### What remains to test on the VM

Before this channel is used, the separately reviewed provisioning should show, on a disposable VM: Run Command (action or managed) running the fixed `seal` command as the bridge's account through `runuser`, with that account owning a `0700` token directory; the token file readable by bridge.ts and not by the desktop user; the envelope arriving whole in the response and `open` taking it; `seal`'s refusals arriving as the fixed form; which of the retention places above actually hold the envelope, and that teardown removes them; Node 22.18 or later on the VM; that the Azure permissions allow only the operator to run commands on the VM; and the preview connecting to the bridge over TLS it trusts.
