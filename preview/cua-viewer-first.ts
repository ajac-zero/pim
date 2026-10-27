/**
 * The viewer-first single-user preview's settings, in one place so the
 * Worker side and the host side name the same numbers (docs/cua-viewer-first-preview.md).
 * It is data only: importing it starts nothing and adds no route, binding or
 * setting to a deployment. Nothing in `src/` or the Node host imports it; the
 * preview's Worker (preview/worker.ts) reads `VIEWER_FIRST` and `agentMode`.
 * It has no imports, so the Node host could read it too.
 */

export const VIEWER_FIRST = {
	/** The one display every launch shows (`ViewerAdapterOptions.displayId`): the VM's primary one. */
	displayId: "primary",
	/** How long Pim lets one observation last, from when it records it: well under `MAX_OBSERVATION_MS` (4 hours). */
	observationMs: 30 * 60 * 1000,
	/** Observations that may be open at once: one person, one desktop. The ledger allows 2 unresolved and the manager 4. */
	openObservations: 1,
	/** The preview's own `PREVIEW_CUA_FIXTURE_OWNER` names the one space; no other space is given a computer, an observation or a lease. */
	spaces: 1,
	/** What stays off: the agent's native-app tools, the optional Cua child (`desktop.ts`'s `cua` option), and takeover. */
	off: ["native-tools", "cua-child", "human-takeover"],
} as const;

/**
 * What drives a preview space's agents while the person watches, which
 * decides what the preview can show. The listing of observations names it
 * (`GET /api/observations`, `agent`).
 *
 * - `stand-in`: the preview's own model (preview/worker.ts), the default. It
 *   calls a tool only when the person's message says `/tool <name> {json}`,
 *   such as `/tool shell {"command": "xdg-open https://example.com"}`, and
 *   the approval that files is the person's to answer. Watching then shows
 *   the wiring: the ordinary shell, files and Chrome reaching the Cua VM and
 *   the viewer showing their effect beside them. It never shows an agent
 *   working the desktop by itself, and isn't evidence that one can.
 * - `real`: a model the person chose in Settings (a ChatGPT plan, or a
 *   provider of their own). Only in this mode can the preview show an agent
 *   acting by itself while it is watched. No real model has driven a Cua VM
 *   here: that is unqualified.
 */
export type AgentMode = "stand-in" | "real";

/** The mode a space's chosen model's provider gives: the preview's own is `preview`. */
export const agentMode = (provider: string): AgentMode => (provider === "preview" ? "stand-in" : "real");

/**
 * The shape of the journal's first file, as a statement for whoever writes the
 * provisioning step. That step is separate and not written: the host never
 * calls this, never creates a journal (`openViewerLaunchManager` blocks on a
 * missing one and `openJournalStore` refuses to create one), and a lost journal
 * is not made again from it. The shape is `Journal` in
 * computer/cua-host/viewer-launch-manager.ts: `revision` must be at least 1,
 * and `generation` any name. `initialized` says who made it.
 */
export function initialJournal(initialized: string) {
	return { version: 1, revision: 1, generation: "provisioned", initialized, entries: [] as never[] };
}
