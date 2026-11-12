# Amp threads (legacy)

**This page documents the retired workspace Amp harness.** New threads with `harness: "amp"` use agent-hosted Orbs instead. See [coding-orbs.md](coding-orbs.md) for current Amp support.

Old thread records that used the workspace Amp harness remain readable, but new starts route to Orbs by default. The Amp Connect field and vault entry continue to work for both legacy and new threads.

## Legacy workspace Amp harness

The workspace Amp harness ran Amp's CLI (`@ampcode/cli`) in a sandbox workspace with the person's Amp access token. It required:
- Workspace image with `@ampcode/cli` installed
- `AMP_API_KEY` injected into the workspace
- Managed settings at `/etc/ampcode/managed-settings.json`
- Egress allowlist entries for `ampcode.com` and `*.ampcode.com`

**This harness is no longer available for new threads.** Attempting to start a thread with `harness: "amp"` and an explicit sandbox `pool` or `provider` will be refused with an error.

## Migration

To use Amp with Pim today:
- Use `harness: "amp"` with no `provider` or `pool` parameters
- This automatically uses agent-hosted Orbs (amp-http)
- The same Amp Connect credential works for both legacy and new threads
