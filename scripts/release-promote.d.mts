import type { Registry } from "./registry.mjs";
export const PIN_LABEL: string;
interface Options {
	owner: string;
	tags: string[];
	qualified: (version: string) => boolean;
	host?: string;
	reg?: Registry;
}
export function completeVersions(options: { base: string; reg: Registry; tags: string[] }): string[];
export function promoteStable(options: Options): { action: "set" | "keep" | "refuse"; pinned?: boolean; stable: string | null; minors: Record<string, string>; why: string };
export function rollbackStable(options: Options & { version: string }): { action: "set" | "keep" | "refuse"; stable: string | null; minors: Record<string, string>; why: string };
