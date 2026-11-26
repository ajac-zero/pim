import type { Registry } from "./registry.mjs";
export const RECORD_LABEL: string;
export const INTENT_LABEL: string;
export function promoteEdge(options: {
	owner: string;
	sha: string;
	host?: string;
	reg?: Registry;
	decide?: (sha: string, promoted: string | undefined, cwd: unknown, edgeExists: boolean) => { action: string; why: string };
	cwd?: string;
}): { action: "promoted" | "skipped" | "refused"; why: string };
export function bootstrapEdge(options: { owner: string; commit: string; head: string; host?: string; reg?: Registry; cwd?: string }): void;
