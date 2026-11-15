/** The CI jobs a change can need, besides the internal-identifier check, which always runs. */
export const JOBS: readonly string[];

/** The jobs a change to `changed` needs: every one for a push to main, otherwise those its files can reach. */
export function selectJobs(changed: readonly string[], options?: { main?: boolean }): Record<string, boolean>;
