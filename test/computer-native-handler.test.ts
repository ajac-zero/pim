import * as fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { NATIVE_TOOL_OP, readNativeOutcome } from "../computer/native-outcome";
import { Link, type Machine } from "../computer/pim-computer";

/**
 * pim-computer's `Link` with and without an embedder's native-app
 * dispatcher, on its own: a temp folder in the test's runtime and stand-in
 * dispatchers, with no space, browser or process behind it. Kept apart from
 * computer.test.ts, whose other tests use the tests' Chrome, so a run can
 * take these without it.
 */

describe("pim-computer's optional native-app dispatcher", () => {
	const SECRET = "hunter2-secret-text";
	const request = { owner: "ada", agentId: "a1", runId: "r1", callId: "c1", tool: "click", arguments: { x: 1 } };
	const completed = { status: "completed", isError: false, code: null, content: [{ type: "text", text: "ok" }], presentation: [] };

	/** A Link over a temp folder, with the stand-in dispatcher if given, and a way to send it a call and read the reply. */
	async function link(native?: Machine["native"]) {
		const root = `/tmp/computer-native-${crypto.randomUUID()}`;
		await fs.mkdir(root, { recursive: true });
		const machine: Machine = {
			root: await fs.realpath(root),
			exec: async () => ({ exitCode: 0, signal: null, stdout: "ran", stderr: "", timedOut: false, truncated: false }),
			...(native ? { native } : {}),
		};
		const replies: Record<string, unknown>[] = [];
		const wire = new Link(machine, (message) => replies.push(JSON.parse(message)));
		return {
			async call(op: string, args: unknown) {
				const id = crypto.randomUUID();
				wire.receive(JSON.stringify({ type: "call", id, op, args }));
				await vi.waitFor(() => expect(replies.some((reply) => reply.id === id)).toBe(true));
				return replies.find((reply) => reply.id === id) as { result?: unknown; error?: { message: string; code?: string } };
			},
			replies,
		};
	}

	it("answers ENOSYS when no dispatcher was given", async () => {
		const reply = await (await link()).call(NATIVE_TOOL_OP, request);
		expect(reply.error?.code).toBe("ENOSYS");
		expect(reply).not.toHaveProperty("result");
	});

	it("gives the dispatcher only the request, once, and sends back its outcomes as results", async () => {
		const outcomes = [completed, { status: "rejected", reason: "busy" }, { status: "rpc_error", code: -32602 }, { status: "unknown", reason: "timeout" }];
		for (const outcome of outcomes) {
			const native = vi.fn(async () => outcome);
			const reply = await (await link(native)).call(NATIVE_TOOL_OP, request);
			expect(native).toHaveBeenCalledTimes(1);
			expect(native).toHaveBeenCalledWith(request);
			expect(reply.error).toBeUndefined();
			expect(readNativeOutcome(reply.result)).toEqual(outcome);
		}
	});

	it("keeps an unknown outcome unknown, and a bad one unreadable to the space", async () => {
		const unknown = await (await link(() => ({ status: "unknown", reason: "transport" }))).call(NATIVE_TOOL_OP, request);
		expect(readNativeOutcome(unknown.result)).toEqual({ status: "unknown", reason: "transport" });

		const circular: Record<string, unknown> = { status: "completed" };
		circular.self = circular;
		const bad: unknown[] = [undefined, null, "completed", [], { status: "done" }, { status: "completed", isError: false }, circular, { status: "unknown", reason: SECRET }];
		for (const answer of bad) {
			const native = vi.fn(() => answer);
			const reply = await (await link(native)).call(NATIVE_TOOL_OP, request);
			expect(native).toHaveBeenCalledTimes(1);
			// Either an error, or a result the space's own check refuses: never a known outcome.
			expect(reply.error ? null : readNativeOutcome(reply.result)).toBeNull();
			expect(JSON.stringify(reply)).not.toContain(SECRET);
		}
	});

	it("answers a throwing or rejecting dispatcher with a fixed error that carries nothing it said", async () => {
		for (const native of [
			() => {
				throw new Error(SECRET);
			},
			async () => {
				throw Object.assign(new Error(SECRET), { code: SECRET });
			},
			() => ({ toJSON: () => { throw new Error(SECRET); } }),
		]) {
			const reply = await (await link(native)).call(NATIVE_TOOL_OP, request);
			expect(reply.error?.code).toBe("EIO");
			expect(reply).not.toHaveProperty("result");
			expect(JSON.stringify(reply)).not.toContain(SECRET);
		}
	});

	it("refuses a malformed call without calling the dispatcher", async () => {
		const native = vi.fn(() => completed);
		const wire = await link(native);
		const bad = [
			undefined,
			{},
			{ ...request, extra: 1 },
			{ ...request, owner: 1 },
			{ ...request, arguments: [] },
			{ ...request, arguments: null },
			{ owner: "ada", agentId: "a1", runId: "r1", callId: "c1", tool: "click" },
		];
		for (const args of bad) expect((await wire.call(NATIVE_TOOL_OP, args)).error?.code).toBe("EINVAL");
		expect(native).not.toHaveBeenCalled();
	});

	it("calls once per call and leaves other operations as they were", async () => {
		const native = vi.fn(() => completed);
		const wire = await link(native);
		await wire.call(NATIVE_TOOL_OP, request);
		await wire.call(NATIVE_TOOL_OP, request);
		expect(native).toHaveBeenCalledTimes(2);

		expect((await wire.call("exec", { command: "true" })).result).toMatchObject({ stdout: "ran" });
		expect((await wire.call("stat", { path: "/workspace" })).result).toMatchObject({ isDirectory: true });
		expect((await wire.call("launch_app", { name: "x" })).error?.code).toBe("ENOSYS");
		expect((await (await link()).call("browser_stop", {})).error?.code).toBe("ENOSYS");
		expect(native).toHaveBeenCalledTimes(2);
	});
});
