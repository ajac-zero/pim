# The Cua evaluation's Pim on Cloudflare: the proposed pivot

Pim can't run on the evaluation's VM under `wrangler dev` with every developer listener off: there is no supported way to turn off its inspectors (`docs/cua-viewer-first-vm-plan.md`, "Wrangler's developer listeners"). The pivot proposed instead runs Pim as a Worker of its own on Cloudflare. A deployed Worker opens no inspector, dev registry or Miniflare listener. The VM keeps only the Cua host, and the person's browser still reaches the viewer directly on it.

This page says what the review branch now has for that, and what it doesn't. **Nothing is deployed, created or provisioned, and nothing here has run.** No resource exists, no part of it is checked against an account, and it isn't known to fit within what the account's existing plan includes.

```diagram
┌─────────────────────┐  passkey session   ┌────────────────────────────────────┐
│ The owner's browser │───────────────────▶│ pim-cua-eval, a Worker of its own  │
│                     │                    │ https://pim-cua-eval.ajac-zero.com │
│                     │                    └─────────────────┬──────────────────┘
│                     │                                      │ launch, end, status
│                     │                                      │ (bridge bearer token)
│                     │  viewer: page,     ┌─────────────────▼──────────────────┐
│                     │  RPC and media     │ The Cua VM: the host only          │
│                     │───────────────────▶│ https://cua-eval.ajac-zero.com     │
└─────────────────────┘  (the launch's     └────────────────────────────────────┘
                          capability)
```

## What the source now has

**An explicit Cloudflare profile for the evaluation mode** (`preview/cua-eval.ts`). The mode no longer assumes celld. `PIM_RUNTIME` must name one of two runtimes; unset or anything else refuses every request (`503`, logged as `runtime`).

- **`celld`:** the operator's ingress in front of a local Worker, as before.
- **`cloudflare`:** Cloudflare reports the client's address in `CF-Connecting-IP`, and the `AUTH_LIMITER` and `API_LIMITER` bindings count the rate limits. Without either binding the mode answers nothing (`503`, logged as `limiters`), because `limited` in `src/runtime.ts` would otherwise let everything through.

**On both, everything else stays as reviewed:**

- registration is closed, whatever `PIM_REGISTRATION` says;
- `/__dev/…` and `/auth/setup-link` are `404` by any method or spelling;
- a request whose URL isn't exactly `PIM_PUBLIC_URL` is `421`;
- one owner is set up once, with the operator's claim code, and the claim's record is never reset.

**The claim window stays shut on Cloudflare.** Plain Pim on Cloudflare lets whoever comes first claim a Pim with no admin for 15 minutes after each deploy (`claimWindowOpen`, `src/runtime.ts`). The evaluation's Directory already refuses any registration without the operator's code. The configuration doesn't bind the deploy's date, and the mode hides it from the window even where it is bound, so the sign-in page never offers a claim (`canClaim` stays false). This matters because setting the owner's secrets after the claim makes a new version.

**A separate configuration, `wrangler.cua-eval.jsonc`.** It is not Pim's `wrangler.jsonc` and not the local preview's `wrangler.preview.jsonc`, which is never deployed. It has:

- **Its own name**, `pim-cua-eval`, so its Durable Objects are its own.
- **One custom domain**, `pim-cua-eval.ajac-zero.com`, with `workers_dev` and `preview_urls` off.
- **No build step.** No repository is to be connected to it through Workers Builds, so nothing on `main` deploys it.
- **No `AI` binding at all**, and no `version_metadata`: Pim's source runs without either (the manifest below). No model can be billed through the Worker.
- **`/__dev/*` among the paths the Worker answers first**, so the Worker refuses them (`404`) rather than the web app's page answering.
- **Every variable in the file,** with no `keep_vars`: `PREVIEW_MODE`, `PIM_RUNTIME`, `PIM_PUBLIC_URL`, `PIM_REGISTRATION` and `PIM_MODELS`.

**It can't be deployed as it stands.** Every resource is a placeholder that can't be filled in by Wrangler on its own (read from the installed `wrangler@4.148.0`, `wrangler-dist/cli.js`):

- **The R2 bucket names aren't valid R2 names** (`REPLACE_WITH_REVIEWED_R2_BUCKET_…`). This is the important one: Wrangler creates a named bucket that doesn't exist yet when it deploys (`isConnectedToExistingResource` L170849, then "Resource name found in config" L170462). An invalid name is refused while the configuration is read (`isValidR2BucketName` L20290, checked at L24659), so the whole file is refused before anything is created.
- **The KV IDs are set, to placeholders.** A KV binding with an `id` is fully specified and never provisioned (`isFullySpecified` L171127), and Cloudflare's API refuses a made-up ID.
- **The rate-limit namespace IDs are placeholders**, which Cloudflare's API refuses. They must become integers of their own, not Pim's.

**Tests** (fake-only, not run): the evaluation-mode tests in `test/preview-cua-fixture.test.ts` now name the runtime. One new test covers Cloudflare's: the control that plain Cloudflare would open the window a minute after a deploy; the closed sign-in page; `404` and `421`; the claim with no code, a wrong code, the operator's code, and again; the record `claimed`; the limiter counting by `CF-Connecting-IP`; and `503` without either limiter. The misconfiguration test adds an empty and an unknown runtime.

Another new test makes a preview space with `AI` and `CF_VERSION_METADATA` unbound, as the candidate binds them. It checks:
- Settings → Model reports `workersAi: false`, with the stand-in as the default and chosen model and nothing else to choose;
- a chat message gets the stand-in's echo;
- nothing logs the missing-binding error ("No model is set up");
- no claim window opens, and the evaluation's sign-in page offers no claim.

For comparison, it then binds a KV-shaped stand-in as `AI`, as the local preview does. The chat still works and no KV method is called, but Pim reports `workersAi: true`. The file has 20 tests.

## The binding manifest

What each binding of `wrangler.cua-eval.jsonc` does along the evaluation's path, read from the source and not run. The path is: the owner's claim and passkey, signing in, Settings, and launching, reading and ending an observation. It leaves out MCP OAuth, images, skills and files, artifacts, account deletion and a real model.

Each binding is described three ways:
- **Startup:** whether the Worker or a Durable Object needs it to construct.
- **Used on the path:** storage operations along the path.
- **Optional paths:** where else it is used.

A binding is left out only where the source has a supported path without it. Otherwise it is kept, and making it is gated with the rest of the resources.

| Binding | Startup | Used on the path | Optional paths | Decision |
| --- | --- | --- | --- | --- |
| `ASSETS` (the web app's files) | No constructor reads it | Every page and script (`src/gateway.ts` L434–460) | MCP's default handler; the preview's stand-in image | **Required.** Uploaded with the deploy; no resource is created |
| `Pim`, `Auth`, `Directory`, `Gallery` (Durable Objects) | Classes the deploy's migrations make | The Directory and the claim record, the Auth object's passkeys and sessions, the space and its observation ledger, and the Gallery's default agent at registration (`src/accounts.ts` L242) | Everything else | **Required.** Made by the deploy; no separate resource |
| `AUTH_LIMITER`, `API_LIMITER` | The evaluation refuses to serve without both (`preview/cua-eval.ts`) | Every sign-in and registration attempt, and every API request | — | **Required.** Namespace IDs are chosen integers, not created |
| `BLOBS` (R2) | Handed to the space's image, skill and legacy-file stores as a field. Their constructors only keep it (`src/pim.ts` L465–546; `src/images.ts` L120; `src/legacy-files.ts` L59) | On the claim's failure paths. A registration that fails after the account is made is abandoned (`src/accounts.ts` L254–257), and a claim whose passkey isn't made in time lapses (`src/directory.ts` L343–344). Either queues the Directory's cleanup, which erases the space: `deleteEverything` lists and deletes under the owner's prefix (`images.deleteAll`, `src/pim.ts` L4017), and `remainingData` lists again (L3983). | Images sent in chat; skills' files; legacy files, which an operator's computer never moves (L6291–6292); account deletion | **Required.** Nothing in the source runs without it: unbound, the claim's cleanup would throw rather than erase |
| `ARTIFACTS` (R2) | Handed to the artifact store, whose constructor only keeps it (`src/artifacts.ts` L392) | The same cleanup: `artifacts.deleteAllFiles` and `anyFiles` list under the owner's prefix (`src/pim.ts` L4018, L3984) | Artifacts made by a tool, which the stand-in model can call with `/tool`; shared and published artifacts | **Required**, for the same reason |
| `OAUTH_KV` | No constructor reads it. The OAuth provider is made on the first `/mcp`, `/oauth/*` or `/.well-known/*` request (`src/mcp-auth.ts` L38–63) | None on the path | Settings → Account: its MCP section asks `GET /auth/connections`, which lists grants in this namespace (`src/mcp-auth.ts` L86–92; `web/src/components/account-settings.tsx` L428–437). Also MCP OAuth itself | **Unresolved, kept.** Nothing on the path uses it, but the source has no fallback: unbound, those requests would fail with a TypeError, not a refusal. Its creation is gated with the rest |
| `AI` | Optional: `AiEnv` types it optional, and without it a request to Workers AI gets `NO_WORKERS_AI`'s error (`src/pim.ts` L337–343, L556, L1273) | None: the preview overrides the default, memory, utility and image models with its stand-ins (`preview/worker.ts`) | Workers AI models | **Left out.** `deploy/celld/wrangler.jsonc` leaves it out the same way |
| `CF_VERSION_METADATA` | Optional: read as `env.CF_VERSION_METADATA?.timestamp`, only for the claim window (`src/runtime.ts` L172–175) | None: the evaluation hides it from the window anyway | — | **Left out**, as celld's profile does |

**The preview's `AI` stand-in is a type filler only.** In `wrangler.preview.jsonc`, `AI` is bound to a KV namespace. Pim never calls a KV method on it: `AI` is used only as Workers AI (`createAI`, `run`). But a bound `AI` makes Pim believe Workers AI is there (`#hasWorkersAi`):
- Settings → Model would offer `preview-model` as a Workers AI model;
- choosing one for a chat would call `run` on the KV namespace, which has no such method.

Leaving `AI` out avoids that.

**What leaving `AI` out changes.** Chats still default to the stand-in model (`chooseModel(null)` on start, `src/pim.ts` L1203, and the preview's `defaultModel`), but Settings → Model lists it as the default, not among the choices (L4635). `test/preview-cua-fixture.test.ts` checks this with `AI` unbound (written, not run).

## What it would take, in order (conditional, not done)

These steps are covered by one conditional approval, not one approval each ("Authorization and budget", below). Nothing has been done, and nothing goes ahead unless the conditions hold.

1. **Radia's preflight**, below: whether the account and zone allow this within the existing plan's included allowances, with no added charge, and which limits bind.
2. **The resources, reviewed:** one KV namespace (`OAUTH_KV`) and two R2 buckets, made once, and two rate-limit namespace IDs chosen (integers, not created), with the real IDs and names put in the file in a reviewed commit.
3. **The web app built** from that commit (`pnpm --filter pim-web build`), and the deploy run by hand with this file named: `wrangler deploy -c wrangler.cua-eval.jsonc`.
   - Deploying a custom domain makes its DNS record and certificate in the `ajac-zero.com` zone. That is part of what the deploy does, so the deploy itself is the provisioning step.
4. **The claim digest** set as a secret, `PREVIEW_EVAL_CLAIM_SHA256`. Only the code's SHA-256 goes to Cloudflare. The operator makes the code privately and gives it to the owner, who opens `/#claim=<code>`.
   - The code isn't in the page's address: a fragment is never sent.
   - It is in the registration's JSON body. So it passes through Cloudflare's TLS termination and the Worker's memory, where it is hashed and compared, and is neither stored nor logged.
5. **The owner's claim and passkey**, then the Cua secrets, which need the owner's ID:
   - `CUA_BRIDGES`, the bridge's HTTPS address and bearer token;
   - `PREVIEW_CUA_FIXTURE=seed`;
   - `PREVIEW_CUA_FIXTURE_OWNER`, the owner's ID.
6. **The host**, started on the VM with `--viewer-public-origin https://cua-eval.ajac-zero.com` and `--viewer-embed-origin https://pim-cua-eval.ajac-zero.com`, its journal made once as `docs/cua-viewer-first-vm-plan.md` says.

## What follows from it

**Sign-in.**
- Passkeys are made for `pim-cua-eval.ajac-zero.com`.
- The session cookie is `__Host-pim-session`, which is host-only. No credential may be scoped to `ajac-zero.com` itself, or it would reach the viewer's host too.
- No OAuth sign-in is configured.

**The bridge's bearer token.**
- It lives in two places: as a Cloudflare secret in `CUA_BRIDGES`, and with the host, under the bridge's own account on the VM.
- It is never given to `pim-desktop` or its agents, and never to a browser.
- Cloudflare's network carries it to the host's public HTTPS address on each launch, end or status, with `x-pim-space`.
- Anyone who can read the Worker's secrets in the Cloudflare account can read it.

**Logs and traces: off.**
- The configuration turns Workers Logs and Cloudflare's traces off (`observability` with `enabled`, `logs` and `traces` all `false`), so neither keeps anything or can add a charge. They stay off unless Radia establishes that turning them on adds no charge.
- Pim's own OpenTelemetry traces stay off as well: nothing sets `OTEL_EXPORTER_OTLP_ENDPOINT` (`src/telemetry.ts`, `exporterFrom`).
- The Worker still writes its console: Pim's JSON lines, such as `preview.refused`, `preview.eval_claim`, `pim.runtime_misconfigured` and the observation records. With logs off, those lines are kept nowhere. They can be seen only live, by an account member running `wrangler tail -c wrangler.cua-eval.jsonc` while they happen. Whether a tail session adds any charge is one more question for Radia.
- A person sees only the response. A refused claim or a `421` says why. A misconfigured evaluation answers only `503` "This preview isn't set up to answer requests.", and its reason (such as `runtime` or `limiters`) is in the console alone. So a misconfiguration found after the fact can't be read back: it has to be reproduced while a tail is running.
- None of those lines holds a claim code, a bearer token or a viewer address, and the viewer's capability never passes through Pim at all.

**The model.** The Worker has only the preview's stand-in model, which is enough to demonstrate the viewer with `/tool` calls. Whether a real agent keeps acting while it is watched is a separate qualification. It needs a real provider added later, under its own approval and cost, and none is configured here.

**No recovery.** The observation ledger and the claim's record live in this Worker's Durable Objects.
- Deleting the Worker, its objects or its resources disposes of them. It never authorizes a new claim, a new space, a new journal or a fresh identity to get past a record left blocked or unconfirmed.
- Settling one needs its own reviewed migration or reconciliation.

## Authorization and budget

- **The account:** the Cloudflare account has Workers Paid ($5 a month), which already exists; it is not a Free account. Its Workers and R2 usage is reported by its owner as 0% of the included allowances. That figure is the owner's report, not checked here.
- **No incremental charge is authorized.** The evaluation may use only what the existing plan already includes. Anything that would add to the bill, past the included allowances or as a new paid feature, stops the work for a decision.
- **Preparation is authorized.** The deployment itself is approved on conditions, not step by step: that it fits the included allowances, as Radia confirms, and that the security checks here hold. Nothing has been created yet.
- **The VM:** Azure, $50 in total, within 48 hours of its creation.

## For Radia's preflight: included allowances, unverified

None of these is checked. Each is a question, not a claim: whether the existing Workers Paid plan includes it without an added charge at the evaluation's scale.

- **Workers:** the requests, CPU time and subrequests included with Workers Paid. Pim's agents run inside Durable Objects, and how much CPU time a run uses is unmeasured.
- **Durable Objects** with SQLite storage: the requests, duration and storage included.
- **KV:** one namespace, within the included reads, writes and storage.
- **R2:** two buckets, within the included storage and operations.
- **Rate limiting bindings:** whether they are available on the account's plan.
- **The custom domain:** `ajac-zero.com` must be a zone on the same Cloudflare account. Its certificate comes from Cloudflare.

- **`wrangler tail`:** whether a live tail adds any charge.

If any of these would add a charge, the pivot stops there for a decision. The Azure budget is for the VM, not for Cloudflare.
