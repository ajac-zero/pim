/**
 * Reading untrusted structures for triggers: what an agent, the API or a
 * computer hands in. Each reader takes `unknown`, refuses anything outside
 * its bounds or with a field it doesn't know, and says where the problem is,
 * so a field that would do nothing is never stored as if it did.
 */

/** A trigger's definition, condition or observation that can't be taken as given. `path` names the field, such as `source.intervalMs`. */
export class TriggerValidationError extends Error {
	readonly path: string;
	constructor(path: string, message: string) {
		super(`${path}: ${message}`);
		this.name = "TriggerValidationError";
		this.path = path;
	}
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Control characters other than tab and newline, which no text a person reads should carry. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** A plain object with only the fields `allowed` names; the fields themselves are left to the caller. */
export function record(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TriggerValidationError(path, "must be an object");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new TriggerValidationError(path, "must be a plain object");
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) throw new TriggerValidationError(path, `has no field ${unknown.map((key) => JSON.stringify(key)).join(" or ")}; it takes ${allowed.join(", ")}`);
	return value as Record<string, unknown>;
}

/**
 * Text of `min` to `max` characters with no control characters; `multiline`
 * lets it hold newlines and tabs, as an instruction or a script does.
 */
export function text(value: unknown, path: string, max: number, options: { min?: number; multiline?: boolean } = {}): string {
	const min = options.min ?? 1;
	if (typeof value !== "string") throw new TriggerValidationError(path, "must be a string");
	if (value.length < min || value.length > max) throw new TriggerValidationError(path, `must be ${min} to ${max} characters`);
	if (value.includes("\u0000") || (options.multiline ? CONTROL.test(value) : /[\u0000-\u001f\u007f]/.test(value))) {
		throw new TriggerValidationError(path, "must not hold control characters");
	}
	return value;
}

/** An opaque id from elsewhere in the space, such as an agent's or a chat's: 1 to 128 characters, no spaces or control characters. */
export function opaqueId(value: unknown, path: string): string {
	const id = text(value, path, 128);
	if (/\s/.test(id)) throw new TriggerValidationError(path, "must not hold spaces");
	return id;
}

/** A whole number from `min` to `max`, both safe integers. */
export function integer(value: unknown, path: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new TriggerValidationError(path, "must be a whole number");
	if (value < min || value > max) throw new TriggerValidationError(path, `must be from ${min} to ${max}`);
	return value;
}

/** A finite number: never NaN or an infinity. */
export function finite(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new TriggerValidationError(path, "must be a finite number");
	return value;
}

export function flag(value: unknown, path: string): boolean {
	if (typeof value !== "boolean") throw new TriggerValidationError(path, "must be true or false");
	return value;
}

export function oneOf<T extends string>(value: unknown, path: string, choices: readonly T[]): T {
	if (typeof value !== "string" || !choices.includes(value as T)) throw new TriggerValidationError(path, `must be one of ${choices.join(", ")}`);
	return value as T;
}

/**
 * An absolute POSIX path on the person's computer: no `.` or `..` parts and
 * no empty ones, so the path a person approved is the path that is used.
 */
export function absolutePath(value: unknown, path: string): string {
	const given = text(value, path, 1_024);
	if (!given.startsWith("/")) throw new TriggerValidationError(path, "must be an absolute path");
	const parts = given.split("/").slice(1);
	if (given !== "/" && parts.some((part) => part === "" || part === "." || part === "..")) {
		throw new TriggerValidationError(path, "must be a normalized path, without empty, '.' or '..' parts");
	}
	return given;
}

export type JsonLimits = { readonly maxBytes: number; readonly maxDepth: number };

/**
 * JSON as parsed from text, within `limits`: finite numbers only, plain
 * objects, at most `maxDepth` levels and `maxBytes` once serialized. Keys
 * that would reach an object's prototype (`__proto__`) are refused, so a
 * lookup never leaves the data.
 */
export function json(value: unknown, path: string, limits: JsonLimits): JsonValue {
	const visit = (node: unknown, at: string, depth: number): void => {
		if (node === null || typeof node === "boolean" || typeof node === "string") return;
		if (typeof node === "number") {
			if (!Number.isFinite(node)) throw new TriggerValidationError(at, "must be a finite number");
			return;
		}
		if (depth >= limits.maxDepth) throw new TriggerValidationError(at, `nests deeper than ${limits.maxDepth} levels`);
		if (Array.isArray(node)) {
			node.forEach((item, index) => visit(item, `${at}[${index}]`, depth + 1));
			return;
		}
		if (typeof node === "object") {
			const prototype = Object.getPrototypeOf(node);
			if (prototype !== Object.prototype && prototype !== null) throw new TriggerValidationError(at, "must be plain JSON");
			for (const [key, item] of Object.entries(node)) {
				if (key === "__proto__") throw new TriggerValidationError(at, "must not have a __proto__ key");
				visit(item, `${at}.${key}`, depth + 1);
			}
			return;
		}
		throw new TriggerValidationError(at, "must be plain JSON");
	};
	visit(value, path, 0);
	const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
	if (bytes > limits.maxBytes) throw new TriggerValidationError(path, `must be at most ${limits.maxBytes} bytes as JSON`);
	return value as JsonValue;
}

/** A JSON object within `limits`. */
export function jsonObject(value: unknown, path: string, limits: JsonLimits): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TriggerValidationError(path, "must be an object");
	return json(value, path, limits) as JsonObject;
}
