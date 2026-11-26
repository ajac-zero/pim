export const IMAGE_NAMES: string[];
export class RegistryError extends Error {}
export interface Registry {
	digest(ref: string): string | null;
	exists(ref: string): boolean;
	label(ref: string, name: string): string | null;
	tag(from: string, ...tags: string[]): void;
	writeRecord(ref: string, name: string, value: string): void;
}
export function registry(run?: (args: string[], input?: string) => string): Registry;
export function dockerRun(args: string[], input?: string): string;
