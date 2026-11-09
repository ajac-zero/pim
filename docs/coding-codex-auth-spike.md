# Spike: can Pim's ChatGPT sign-in log Codex CLI in?

The question is whether the tokens from Pim's own "Sign in with ChatGPT" ([`src/chatgpt.ts`](../src/chatgpt.ts)) could be written to `~/.codex/auth.json`, so the unmodified Codex CLI in a person's workspace uses their ChatGPT plan without a login of its own.

**The answer is no.** Codex's ChatGPT mode uses tokens from another OAuth client, with other scopes, for another backend, and it refreshes them with that client. Pim's tokens are for `https://api.openai.com/v1` and refresh only with the client issued to Pim. The recommended path is for Codex to log itself in inside the person's sandbox with `codex login --device-auth`, and for the vault ([`src/coding/vault`](../src/coding/vault)) to keep the `auth.json` that results.

This comes from reading code and public docs only: openai/codex `main` at `e54a5713` (2026-11-09) and OpenAI's docs as of the same date. No real tokens were read or used, and no live calls were made.

## The two flows side by side

| | Codex CLI, ChatGPT mode | Pim (`src/chatgpt.ts`, SIWC) |
| --- | --- | --- |
| Client | `app_EMoamEEZ73f0CkXaXp7hrann`, fixed (`codex-rs/login/src/auth/manager.rs` L1894-1902) | `dynamic_agent_client` at first, then the client issued to Pim's agent, `ext_agent_host_id` |
| Issuer | `https://auth.openai.com` | `https://auth.openai.com` |
| Endpoints | `/oauth/authorize`, `/oauth/token`; device code at `/api/accounts/deviceauth/usercode` and `/token` | `/api/accounts/authorize`, `/api/accounts/oauth/token` |
| Scopes | `openid profile email offline_access api.connectors.read api.connectors.invoke` (`codex-rs/login/src/server.rs` L580-623) | `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` |
| Resource (token audience) | none requested (`resource: None`) | `https://api.openai.com/v1`; the access token's `aud` is that URL ([SIWC token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)) |
| Backend | `https://chatgpt.com/backend-api/codex/responses` with `chatgpt-account-id` (`codex-rs/model-provider-info/src/lib.rs` L87, L471-490; `codex-rs/model-provider/src/bearer_auth_provider.rs` L34-50) | `https://api.openai.com/v1` |
| Account id | `tokens.account_id`, from the id token's `https://api.openai.com/auth`.`chatgpt_account_id` claim (`codex-rs/login/src/token_data.rs` L86-113) | not kept; whether a SIWC id token carries that claim is undocumented |
| Refresh | JSON `grant_type=refresh_token` to `/oauth/token`, no `resource`, client from `tokens.oauth_provenance.client_id` or else Codex's own (`manager.rs` L1806-1830, L3748-3753); refresh tokens rotate, and reuse is a permanent failure (L1864-1870) | form-encoded to `/api/accounts/oauth/token` with `resource=https://api.openai.com/v1` and the issued client, "not `dynamic_agent_client`" ([accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)) |

`auth.json` (`codex-rs/login/src/auth/storage.rs` L51-77) is `{ auth_mode, OPENAI_API_KEY, tokens: { id_token, access_token, refresh_token, account_id, oauth_provenance? }, last_refresh }`. Codex writes it back itself, atomically through a temporary file and a rename, whenever it refreshes, which it does once the access token is within 5 minutes of expiring or after a 401.

## Why Pim's tokens don't fit

- **Audience and backend.** Codex sends ChatGPT-mode tokens to `chatgpt.com/backend-api/codex`. Pim's access token is minted for `api.openai.com/v1`. Nothing public says that backend accepts it, and the scopes differ from the ones Codex's own tokens carry.
- **Account id.** Codex needs `chatgpt_account_id` for its `chatgpt-account-id` header. Pim's flow doesn't keep one, and the SIWC docs don't say its id token has it.
- **Refresh.** Without `oauth_provenance`, Codex would refresh with its own client id, which the token wasn't issued to. With it, Codex would still send a JSON body without `resource` to `/oauth/token`, which is not the refresh the SIWC docs describe. Either way the login would likely break within the hour; this is inferred from the docs, not tested.
- **Shared refresh token.** If Pim and the CLI both held the same rotating refresh token, the first refresh would invalidate the other's copy (`refresh_token_reused`).
- **Internal only.** Codex's app-server accepts external tokens as `chatgptAuthTokens`, but the protocol marks it "[UNSTABLE] FOR OPENAI INTERNAL USE ONLY - DO NOT USE" and requires "the same scopes that Codex-managed ChatGPT auth tokens have" (`codex-rs/app-server-protocol/src/protocol/v2/account.rs` L98-117).

## The one documented way to reuse SIWC tokens, and why not now

OpenAI documents running Codex on a SIWC token: [`codex app-server` with a custom provider](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) whose `base_url` is `https://api.openai.com/v1`, `env_key="ACCESS_TOKEN"` and `requires_openai_auth=false`. The app refreshes the token itself and restarts the app-server with the new one. "No separate Codex sign-in is required."

It doesn't suit Pim yet:

- It puts Pim's access token in the workspace, which coding threads promise never to do with model credentials. Every refresh would also have to reach a running sandbox.
- The [SIWC overview](https://developers.openai.com/siwc/token-sharing-open-source) covers "open-source and locally hosted apps. If you're interested in offering it in a paid or remotely hosted app, complete the interest form." Pim is a hosted Worker. The [self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) page also says host-specific attribution and revocation for transferred sessions is "not yet available".
- It drives the app-server protocol with a custom provider, not the CLI's own ChatGPT mode, and the [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) list Responses features it lacks.

Revisit it if OpenAI accepts Pim as a hosted SIWC app.

## Recommended path

1. In the person's own workspace, run `codex login --device-auth` with `CODEX_HOME` set to the vault's directory (`harnessEnv("codex")`; Codex requires that directory to exist). Codex prints a code; the person enters it at `https://auth.openai.com/codex/device` (`codex-rs/login/src/device_code_auth.rs`). The docs call device-code login beta, and the person may first need to turn it on in ChatGPT's security settings ([auth docs](https://learn.chatgpt.com/docs/auth)). A 404 means it is off.
2. When the command exits, `writeBackHarnessCredentials` keeps `auth.json` and `config.toml` as the person's sealed vault entry. Pim never parses them.
3. Before each later run, `restoreHarnessCredentials` puts them back into that person's workspace, and keeps what Codex refreshed afterwards. Keep `cli_auth_credentials_store` at its default, `file`, so the login is in `auth.json` and not a keyring.
4. Run one Codex harness per person at a time. OpenAI asks for "one `auth.json` per runner or per serialized workflow stream", and says not to share it "across concurrent jobs" ([CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth)). Two runs refreshing the same rotating token would invalidate one another; the vault keeps the first write-back and drops the other, but it can't stop the provider from revoking.

OpenAI's guidance, which the disclosure in `HARNESS_DISCLOSURES` passes on: "treat `~/.codex/auth.json` like a password: it contains access tokens", and for a ChatGPT login in automation, "Do not use this workflow for public or open-source repositories." An OpenAI API key is the alternative OpenAI recommends for automation.

## Not settled

- Whether `chatgpt.com/backend-api/codex` would accept a token with `aud=https://api.openai.com/v1`. Testing this needs a real account and was out of scope.
- Whether a SIWC id token carries `chatgpt_account_id`.
- How long a vaulted login lasts between runs. Codex refreshes on use, so a login left unused until its refresh token expires has to be made again.
