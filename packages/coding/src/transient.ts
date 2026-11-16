/**
 * Whether an error is Cloudflare's own, transient trouble reaching another
 * Durable Object or its storage from this one: the callee is overloaded or
 * reset, or the connection to it dropped. Such an error says nothing about
 * the remote service a coding thread drives (an Amp thread, say), and a
 * later try may well succeed.
 *
 * Deterministic failures, such as a `TypeError`, a refusal from the remote
 * service, or a method the callee doesn't have, are never transient here.
 * The platform marks errors it knows are worth retrying with `retryable`,
 * and `overloaded` for the ones from too much load; those flags count, and
 * so do the messages the platform words them with.
 */
export function isTransientDoOverload(error: unknown): boolean {
	if (error === null || typeof error !== "object") return false;
	const flags = error as { retryable?: unknown; overloaded?: unknown; name?: unknown; message?: unknown };
	if (flags.overloaded === true) return true;
	const name = typeof flags.name === "string" ? flags.name : "";
	// Our own typed failures and programming errors are not the platform's.
	if (name === "TypeError" || name === "RangeError" || name === "SyntaxError" || name === "ReferenceError" || name.startsWith("Orb")) return false;
	const message = typeof flags.message === "string" ? flags.message : "";
	if (/does not implement the method/i.test(message)) return false;
	if (OVERLOAD_MESSAGE.test(message)) return true;
	return flags.retryable === true;
}

const OVERLOAD_MESSAGE =
	/Durable Object is overloaded|Requests queued for too long|Network connection lost|Cannot resolve Durable Object|Durable Object reset because its code was updated|Durable Object storage operation exceeded timeout|Cannot access storage because object has moved|The Durable Object's code has been updated|Durable Object .* (?:is|was) (?:resetting|restarting)|Server is overloaded/i;
