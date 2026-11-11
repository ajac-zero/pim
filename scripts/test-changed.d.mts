/** What `pnpm test:changed` runs for a diff's files: the whole suite and why, or the projects it maps the change to. */
export type TestRun =
	| { readonly full: true; readonly reason: string }
	| { readonly full: false; readonly root: boolean; readonly web: boolean };

/** What the files a diff touches should run: the whole suite when a change can reach any test or nothing maps to one, otherwise the root project for anything outside web/ and the web app for web/. */
export function selectRuns(changed: readonly string[]): TestRun;
