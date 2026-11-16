import { describe, expect, it } from "vitest";
import { OrbError, OrbUnreachableError } from "../src/orb/types";
import { isTransientDoOverload } from "../src/transient";

describe("isTransientDoOverload", () => {
	it.each([
		new Error("Durable Object is overloaded. Requests queued for too long."),
		new Error("Network connection lost."),
		new Error("Cannot resolve Durable Object due to transient issue on remote node."),
		new Error("Durable Object reset because its code was updated."),
		Object.assign(new Error("anything"), { overloaded: true }),
		Object.assign(new Error("some internal hiccup"), { retryable: true }),
	])("treats the platform's overload and transient errors as transient: %s", (error) => {
		expect(isTransientDoOverload(error)).toBe(true);
	});

	it.each([
		new TypeError("Durable Object is overloaded"),
		new TypeError('The RPC receiver does not implement the method "codingKeepImage".'),
		new OrbError("Amp rejected it", "orb_request"),
		new OrbUnreachableError("Network connection lost"),
		new Error("Amp API rejected the request (400)"),
		"Durable Object is overloaded",
		null,
		undefined,
	])("leaves deterministic and remote failures alone: %s", (error) => {
		expect(isTransientDoOverload(error)).toBe(false);
	});
});
