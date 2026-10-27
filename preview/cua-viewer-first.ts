/**
 * The viewer-first single-user preview's settings, in one place so the
 * Worker side and the host side name the same numbers (docs/cua-viewer-first-preview.md).
 * It is data only, and it is not an assembled or tested function: importing it
 * starts nothing, adds no route, binding or setting to a deployment, and nothing
 * in `src/` or the Node host imports it. It has no imports, so the preview's
 * Worker can read it. It has not been run or type-checked.
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
