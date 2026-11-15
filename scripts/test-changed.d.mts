/** What `pnpm test:changed` runs for a diff's files: the whole suite and why, or the projects it maps the change to. */
export type TestRun =
	| { readonly full: true; readonly reason: string }
	| { readonly full: false; readonly root: boolean; readonly web: boolean; readonly daemons: boolean };

/** What the files a diff touches should run: the whole suite when a change can reach any test or nothing maps to one, otherwise the root project for anything outside web/ and the daemons, the web app for web/ and the files of src/ it imports, and the daemons' tests for a daemon. */
export function selectRuns(changed: readonly string[]): TestRun;
