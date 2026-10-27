/**
 * The Cua computer's start (../cua-computer.ts) and the credential it reads
 * (../cua-credential.ts), with stand-ins for everything outside this
 * process: descriptor 3 is a stand-in reader over bytes in memory, spacesd is
 * a `fetch` that records what it was sent and answers nothing useful, and
 * serving is a function that records what it was given. No descriptor, file,
 * process, socket, browser or shell is opened, and nothing is sent anywhere.
 * What happens to a real inherited descriptor (that Node leaves it open
 * across a later spawn unless it is closed) is not shown here.
 *
 *   node --test test/cua-computer.test.ts
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import type { NativeCall, ServeSettings } from "../../pim-computer.ts";
import { CuaComputerRefused, startCuaComputer } from "../cua-computer.ts";
import { CREDENTIAL_FD, type CredentialReader, CredentialRefused, type CredentialStat, MAX_CREDENTIAL_BYTES, MAX_TOKEN_BYTES, readCredential } from "../cua-credential.ts";
import type { Fetch } from "../native-mcp.ts";

const UID = 1000;
const SECRET = "spacesd-stand-in-token-0123456789abcdef";
const OWNER = "o_cua-space";
const ORIGIN = "https://spacesd.test:7443";

/**
 * Descriptor 3 as a stand-in: `bytes` behind a status, read at most `chunk`
 * bytes at a time. It records each read and each close, every buffer it was
 * handed, and whether a read came after the close.
 */
function descriptor(bytes: Buffer | string, options: { stat?: Partial<CredentialStat>; chunk?: number; fstatThrows?: boolean; readThrows?: boolean; grows?: number } = {}) {
	const data = typeof bytes === "string" ? Buffer.from(bytes, "latin1") : bytes;
	const record = {
		reads: [] as { fd: number; offset: number; length: number; position: number }[],
		buffers: [] as Buffer[],
		closed: [] as number[],
		readAfterClose: false,
	};
	const reader: CredentialReader = {
		fstat: (fd) => {
			assert.equal(fd, CREDENTIAL_FD);
			if (options.fstatThrows) throw Object.assign(new Error(`EBADF ${SECRET}`), { code: "EBADF" });
			return { isFile: () => true, uid: UID, mode: 0o100600, nlink: 1, size: data.length, ...options.stat };
		},
		read: (fd, buffer, offset, length, position) => {
			if (record.closed.length > 0) record.readAfterClose = true;
			record.reads.push({ fd, offset, length, position });
			record.buffers.push(buffer);
			if (options.readThrows) throw Object.assign(new Error(`EIO ${SECRET}`), { code: "EIO" });
			// A file that grew after its status was read, as far as `grows` more bytes.
			const file = options.grows ? Buffer.concat([data, Buffer.alloc(options.grows, 0x61)]) : data;
			const part = file.subarray(position, position + Math.min(length, options.chunk ?? length));
			part.copy(buffer, offset);
			return part.length;
		},
		close: (fd) => {
			record.closed.push(fd);
		},
	};
	return { reader, record };
}

const refusedFor = (reason: string) => (error: unknown) => error instanceof CredentialRefused && error.reason === reason && !error.message.includes(SECRET);

describe("reading the credential from descriptor 3", () => {
	it("reads the token from the start, by position, in parts, less one newline, closes the descriptor once and zeroes what it read into", () => {
		const { reader, record } = descriptor(`${SECRET}\n`, { chunk: 7 });
		assert.equal(readCredential(CREDENTIAL_FD, UID, reader), SECRET);
		assert.deepEqual(record.closed, [CREDENTIAL_FD]);
		assert.equal(record.readAfterClose, false);
		// Each read asks for what is left of the bound, at the position it has reached.
		let position = 0;
		for (const read of record.reads) {
			assert.equal(read.fd, CREDENTIAL_FD);
			assert.equal(read.position, position);
			assert.equal(read.offset, position);
			assert.equal(read.length, MAX_CREDENTIAL_BYTES + 1 - position);
			position += Math.min(7, SECRET.length + 1 - position);
		}
		assert.equal(record.reads.at(-1)!.position, SECRET.length + 1, "it reads until the end");
		for (const buffer of record.buffers) assert.ok(buffer.every((byte) => byte === 0), "the buffer is zeroed");
	});

	it("takes a token of the longest length, with or without its newline, and nothing longer", () => {
		const longest = "t".repeat(MAX_TOKEN_BYTES);
		assert.equal(readCredential(CREDENTIAL_FD, UID, descriptor(longest).reader), longest);
		assert.equal(readCredential(CREDENTIAL_FD, UID, descriptor(`${longest}\n`).reader), longest);
		const longer = descriptor(`${longest}t`);
		assert.throws(() => readCredential(CREDENTIAL_FD, UID, longer.reader), refusedFor("format"));
		assert.deepEqual(longer.record.closed, [CREDENTIAL_FD]);
	});

	it("refuses what isn't a lone, private, regular file of the user's, or isn't a token, and closes the descriptor every time", () => {
		const cases: [string, ReturnType<typeof descriptor>, string, number?][] = [
			["no descriptor 3", descriptor(SECRET, { fstatThrows: true }), "descriptor"],
			["a descriptor that isn't a file (a pipe, a terminal)", descriptor(SECRET, { stat: { isFile: () => false } }), "not-file"],
			["a file its group can read", descriptor(SECRET, { stat: { mode: 0o100640 } }), "mode"],
			["a file others can read", descriptor(SECRET, { stat: { mode: 0o100604 } }), "mode"],
			["a set-user-ID file", descriptor(SECRET, { stat: { mode: 0o104600 } }), "mode"],
			["another user's file", descriptor(SECRET, { stat: { uid: UID + 1 } }), "mode"],
			["a file with two names", descriptor(SECRET, { stat: { nlink: 2 } }), "links"],
			["an empty file", descriptor(""), "size"],
			["a file larger than a token and its newline", descriptor("t".repeat(MAX_CREDENTIAL_BYTES + 1)), "size"],
			["a file that grows past the bound after its status is read", descriptor(SECRET, { grows: MAX_CREDENTIAL_BYTES }), "size"],
			["a read that throws", descriptor(SECRET, { readThrows: true }), "read"],
			["only a newline", descriptor("\n"), "format"],
			["a token with a space", descriptor("spacesd token"), "format"],
			["a token with a NUL", descriptor("spacesd\0token"), "format"],
			["a token with two newlines", descriptor(`${SECRET}\n\n`), "format"],
			["a token with a carriage return", descriptor(`${SECRET}\r\n`), "format"],
			["a token that isn't ASCII", descriptor(Buffer.from("spacesd-tökén", "utf8")), "format"],
			["the root user", descriptor(SECRET), "root-user", 0],
			["no user ID", descriptor(SECRET), "user", -1],
		];
		for (const [name, { reader, record }, reason, uid] of cases) {
			assert.throws(() => readCredential(CREDENTIAL_FD, uid === -1 ? undefined : (uid ?? UID), reader), refusedFor(reason), name);
			assert.deepEqual(record.closed, [CREDENTIAL_FD], `${name}: closed once`);
			assert.equal(record.readAfterClose, false, name);
			for (const buffer of record.buffers) assert.ok(buffer.every((byte) => byte === 0), `${name}: zeroed`);
		}
	});

	it("refuses a reader that says it read more than it was asked for", () => {
		const { record } = descriptor(SECRET);
		const lying: CredentialReader = {
			fstat: () => ({ isFile: () => true, uid: UID, mode: 0o100600, nlink: 1, size: SECRET.length }),
			read: (_fd, _buffer, _offset, length) => length + 1,
			close: (fd) => record.closed.push(fd),
		};
		assert.throws(() => readCredential(CREDENTIAL_FD, UID, lying), refusedFor("read"));
		assert.deepEqual(record.closed, [CREDENTIAL_FD]);
	});
});

describe("starting the Cua computer", () => {
	/** A start with stand-ins: what `serve` was given and when, what was sent to spacesd, and the descriptor's record. */
	function start(options: { bytes?: string; owner?: string; origin?: string; root?: string; serveThrows?: boolean; stat?: Partial<CredentialStat> } = {}) {
		const { reader, record } = descriptor(options.bytes ?? `${SECRET}\n`, options.stat ? { stat: options.stat } : {});
		const served: { settings: ServeSettings; closedBefore: number[] }[] = [];
		const sent: { url: string; authorization: string | null }[] = [];
		const fetch: Fetch = async (url, init) => {
			sent.push({ url, authorization: new Headers(init.headers).get("authorization") });
			throw new Error("the stand-in answers nothing");
		};
		const started = startCuaComputer({
			root: options.root ?? "/home/desktop/workspace",
			chrome: "/opt/google/chrome/chrome",
			headful: false,
			owner: options.owner ?? OWNER,
			origin: options.origin ?? ORIGIN,
			reader,
			uid: UID,
			fetch,
			serve: async (settings) => {
				served.push({ settings, closedBefore: [...record.closed] });
				if (options.serveThrows) throw new Error(`serve failed ${SECRET}`);
			},
		});
		return { started, served, sent, record };
	}

	const request = (change: Partial<NativeCall> = {}): NativeCall => ({ owner: OWNER, agentId: "agent-1", runId: "run-1", callId: "call-1", tool: "list_apps", arguments: {}, ...change });

	it("closes descriptor 3 before it serves, and serves once with only the folder, browser and a dispatcher", async () => {
		const { started, served, record } = start();
		await started;
		assert.equal(served.length, 1);
		assert.deepEqual(served[0]!.closedBefore, [CREDENTIAL_FD], "closed before any call can be taken");
		assert.deepEqual(record.closed, [CREDENTIAL_FD], "and only once");
		const { settings } = served[0]!;
		assert.deepEqual(Object.keys(settings).sort(), ["chrome", "folder", "headful", "native"]);
		assert.deepEqual({ ...settings, native: typeof settings.native }, { folder: "/home/desktop/workspace", chrome: "/opt/google/chrome/chrome", headful: false, native: "function" });
		assert.ok(!JSON.stringify(settings).includes(SECRET), "nothing it serves with holds the token");
	});

	it("refuses another owner's call unsent, and sends its own only to spacesd's origin, with the token only as the bearer", async () => {
		const { started, served, sent } = start();
		await started;
		const native = served[0]!.settings.native!;
		for (const owner of ["o_other-space", `${OWNER} `, ""]) {
			assert.deepEqual(await native(request({ owner })), { status: "rejected", reason: "identity" }, owner);
		}
		assert.deepEqual(sent, [], "nothing was sent for another owner");
		// Its own call: setup is sent to the origin, which answers nothing, so the run is unavailable and no tool is called.
		const outcome = await native(request());
		assert.deepEqual(outcome, { status: "rejected", reason: "unavailable" });
		assert.deepEqual(sent, [{ url: `${ORIGIN}/mcp`, authorization: `Bearer ${SECRET}` }]);
		assert.ok(!JSON.stringify(outcome).includes(SECRET));
	});

	it("refuses a credential before it serves, with a fixed reason, the descriptor closed and nothing sent", async () => {
		for (const [name, options, reason] of [
			["a file others can read", { stat: { mode: 0o100644 } }, "credential-mode"],
			["a file too large", { bytes: "t".repeat(MAX_CREDENTIAL_BYTES + 1) }, "credential-size"],
			["no token", { bytes: "\n" }, "credential-format"],
		] as const) {
			const { started, served, sent, record } = start(options);
			await assert.rejects(started, (error: unknown) => error instanceof CuaComputerRefused && error.reason === reason && !error.message.includes(SECRET), name);
			assert.deepEqual(served, [], `${name}: nothing served`);
			assert.deepEqual(sent, [], name);
			assert.deepEqual(record.closed, [CREDENTIAL_FD], name);
		}
	});

	it("refuses an owner or origin the dispatcher doesn't take, after closing the descriptor, before it serves", async () => {
		for (const [name, change] of [
			["an owner with a space", { owner: "o_cua space" }],
			["an empty owner", { owner: "" }],
			["an origin with a path", { origin: `${ORIGIN}/mcp` }],
			["an origin with a slash after it", { origin: `${ORIGIN}/` }],
			["plain HTTP off loopback", { origin: "http://spacesd.test:7443" }],
			["an origin with credentials", { origin: "https://ada:pw@spacesd.test:7443" }],
		] as const) {
			const { started, served, sent, record } = start(change);
			await assert.rejects(started, (error: unknown) => error instanceof CuaComputerRefused && error.reason === "native-settings" && !error.message.includes(SECRET), name);
			assert.deepEqual(served, [], name);
			assert.deepEqual(sent, [], name);
			assert.deepEqual(record.closed, [CREDENTIAL_FD], name);
		}
		const relative = start({ root: "workspace" });
		await assert.rejects(relative.started, (error: unknown) => error instanceof CuaComputerRefused && error.reason === "settings");
		assert.deepEqual(relative.record.closed, [CREDENTIAL_FD]);
	});

	it("passes on a failure to serve as it came, with the descriptor already closed", async () => {
		const { started, served, record } = start({ serveThrows: true });
		await assert.rejects(started, /serve failed/);
		assert.equal(served.length, 1);
		assert.deepEqual(served[0]!.closedBefore, [CREDENTIAL_FD]);
		assert.deepEqual(record.closed, [CREDENTIAL_FD]);
	});
});
