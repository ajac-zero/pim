/**
 * Managed processes' durable records: a launch intent and a completion
 * receipt per handle, in a state folder of the person's computer, and the
 * supervisor that writes them around one job. `FileProcessProvider` reads
 * them for the process observer (./process.ts). The contract is in
 * docs/triggers-adapters.md.
 *
 * Inert, and not a launcher. Nothing in pim-computer calls
 * `superviseManaged` or hands a handle to the space: which jobs may be
 * started, after what approval, detached how from pim-computer, with the
 * state folder where, and when old records go, are all still to be decided.
 * Only the tests run it, on tiny jobs of their own.
 *
 * Linux only: a process's start time and the boot's id come from `/proc`.
 * Elsewhere `LinuxProcessProbe` throws, so a watch fails to start rather
 * than trusting a process id alone.
 */

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type CompletionReceipt, HANDLE_PATTERN, type LaunchIntent, type Liveness, type ManagedProcessProvider, type ManagedRecord, type ProcessIdentity, sameIdentity } from "./process.ts";

export const INTENT_FILE = "intent.json";
export const RECEIPT_FILE = "receipt.json";
/** The most bytes a record may have; a real one has about 300. */
const RECORD_BYTES = 4_096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIGNAL = /^SIG[A-Z0-9]{1,12}$/;

export class ManagedRecordError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

/**
 * Checks a state folder before anything is read from it or written to it:
 * an absolute path to a real folder (not a link), owned by this user, that
 * no one else may write to or read.
 */
export async function checkStateDir(dir: string): Promise<string> {
	if (!path.isAbsolute(dir)) throw new ManagedRecordError("state_dir_not_absolute");
	const stat = await fs.lstat(dir);
	if (!stat.isDirectory() || !ownAndPrivate(stat)) throw new ManagedRecordError("state_dir_unsafe");
	return dir;
}

function handleDir(stateDir: string, handle: string): string {
	if (!HANDLE_PATTERN.test(handle)) throw new ManagedRecordError("handle_invalid");
	return path.join(stateDir, handle);
}

/** Whether a folder or file is this user's own and closed to everyone else. */
function ownAndPrivate(stat: { uid: number; mode: number }): boolean {
	return (stat.mode & 0o077) === 0 && (typeof process.getuid !== "function" || stat.uid === process.getuid());
}

/**
 * Reads one record file: a regular file, not a link, this user's own and
 * closed to everyone else (as `writeOnce` makes it, `0600`), of at most
 * 4 KiB. Null when it isn't there. A record that is anything else is
 * refused, not narrowed: something other than its supervisor made it so.
 */
async function readRecordFile(file: string): Promise<unknown> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null;
		throw new ManagedRecordError(code === "ELOOP" ? "record_unsafe" : "record_unreadable");
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > RECORD_BYTES || !ownAndPrivate(stat)) throw new ManagedRecordError("record_unsafe");
		const buffer = Buffer.alloc(RECORD_BYTES + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > RECORD_BYTES) throw new ManagedRecordError("record_unsafe");
		try {
			return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
		} catch {
			throw new ManagedRecordError("record_malformed");
		}
	} finally {
		await handle.close();
	}
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ManagedRecordError("record_malformed");
	const given = Object.keys(value);
	if (given.length !== keys.length || !keys.every((key) => given.includes(key))) throw new ManagedRecordError("record_malformed");
	return value as Record<string, unknown>;
}

function time(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ManagedRecordError("record_malformed");
	return value as number;
}

function readIdentity(value: unknown): ProcessIdentity {
	const given = exact(value, ["bootId", "pid", "startTime"]);
	if (typeof given.bootId !== "string" || !UUID.test(given.bootId)) throw new ManagedRecordError("record_malformed");
	if (!Number.isSafeInteger(given.pid) || (given.pid as number) < 1) throw new ManagedRecordError("record_malformed");
	if (typeof given.startTime !== "string" || !/^[0-9]{1,20}$/.test(given.startTime)) throw new ManagedRecordError("record_malformed");
	return { bootId: given.bootId, pid: given.pid as number, startTime: given.startTime };
}

export function readIntent(value: unknown): LaunchIntent {
	const given = exact(value, ["version", "handle", "supervisor", "launchedAt"]);
	if (given.version !== 1 || typeof given.handle !== "string" || !HANDLE_PATTERN.test(given.handle)) throw new ManagedRecordError("record_malformed");
	return { version: 1, handle: given.handle, supervisor: readIdentity(given.supervisor), launchedAt: time(given.launchedAt) };
}

export function readReceipt(value: unknown): CompletionReceipt {
	const given = exact(value, ["version", "handle", "supervisor", "exitCode", "signal", "endedAt"]);
	if (given.version !== 1 || typeof given.handle !== "string" || !HANDLE_PATTERN.test(given.handle)) throw new ManagedRecordError("record_malformed");
	const exited = Number.isSafeInteger(given.exitCode) && (given.exitCode as number) >= 0 && (given.exitCode as number) <= 255 && given.signal === null;
	const signalled = given.exitCode === null && typeof given.signal === "string" && SIGNAL.test(given.signal);
	if (!exited && !signalled) throw new ManagedRecordError("record_malformed");
	return { version: 1, handle: given.handle, supervisor: readIdentity(given.supervisor), exitCode: given.exitCode as number | null, signal: given.signal as string | null, endedAt: time(given.endedAt) };
}

/** Reads a handle's records; null when no intent was ever written for it. */
export async function readManagedRecord(stateDir: string, handle: string): Promise<ManagedRecord | null> {
	const dir = handleDir(stateDir, handle);
	try {
		const stat = await fs.lstat(dir);
		if (!stat.isDirectory() || !ownAndPrivate(stat)) throw new ManagedRecordError("record_unsafe");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const intentValue = await readRecordFile(path.join(dir, INTENT_FILE));
	if (intentValue === null) return null;
	const intent = readIntent(intentValue);
	if (intent.handle !== handle) throw new ManagedRecordError("record_malformed");
	const receiptValue = await readRecordFile(path.join(dir, RECEIPT_FILE));
	return { intent, receipt: receiptValue === null ? null : readReceipt(receiptValue) };
}

/** Writes `value` to a new file beside `file`, synced, and puts it in place only if nothing is there yet; then syncs the folder. */
async function writeOnce(file: string, value: unknown): Promise<void> {
	const temporary = `${file}.${process.pid}.tmp`;
	const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		// A link fails if the record exists already, so a record, once written, is never replaced.
		await fs.link(temporary, file);
	} finally {
		await fs.unlink(temporary).catch(() => undefined);
	}
	const dir = await fs.open(path.dirname(file), constants.O_RDONLY);
	try {
		await dir.sync();
	} finally {
		await dir.close();
	}
}

/** Records that `intent.handle` is its supervisor's. A handle is launched once: its folder must not exist yet. */
export async function writeLaunchIntent(stateDir: string, intent: LaunchIntent): Promise<void> {
	const checked = readIntent(intent);
	const dir = handleDir(await checkStateDir(stateDir), checked.handle);
	await fs.mkdir(dir, { mode: 0o700 });
	await writeOnce(path.join(dir, INTENT_FILE), checked);
	const parent = await fs.open(stateDir, constants.O_RDONLY);
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
}

/** Records how the job of `receipt.handle` ended, once, and only for the supervisor its intent names. */
export async function writeCompletionReceipt(stateDir: string, receipt: CompletionReceipt): Promise<void> {
	const checked = readReceipt(receipt);
	const record = await readManagedRecord(await checkStateDir(stateDir), checked.handle);
	if (!record || !sameIdentity(record.intent.supervisor, checked.supervisor)) throw new ManagedRecordError("identity_mismatch");
	await writeOnce(path.join(handleDir(stateDir, checked.handle), RECEIPT_FILE), checked);
}

/** Process identities from Linux's `/proc`. */
export class LinuxProcessProbe {
	readonly #proc: string;
	constructor(proc = "/proc") {
		this.#proc = proc;
	}

	async bootId(): Promise<string> {
		if (process.platform !== "linux") throw new ManagedRecordError("platform_unsupported");
		const id = (await fs.readFile(path.join(this.#proc, "sys/kernel/random/boot_id"), "utf8")).trim();
		if (!UUID.test(id)) throw new ManagedRecordError("boot_id_unreadable");
		return id;
	}

	/** The identity of the process with `pid` now, and whether it has ended unreaped; null when there is none. */
	async read(pid: number): Promise<{ identity: ProcessIdentity; zombie: boolean } | null> {
		if (process.platform !== "linux") throw new ManagedRecordError("platform_unsupported");
		if (!Number.isSafeInteger(pid) || pid < 1) return null;
		let stat: string;
		try {
			stat = await fs.readFile(path.join(this.#proc, String(pid), "stat"), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return null;
			throw error;
		}
		// The command name, in parentheses, may hold anything; the fields after its last `)` start with the state (field 3).
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const state = fields[0];
		const startTime = fields[19];
		if (!state || !startTime || !/^[0-9]+$/.test(startTime)) throw new ManagedRecordError("stat_unreadable");
		return { identity: { bootId: await this.bootId(), pid, startTime }, zombie: state === "Z" || state === "X" };
	}
}

/** Reads managed processes' records from a state folder, and their supervisors' liveness from `/proc`. */
export class FileProcessProvider implements ManagedProcessProvider {
	readonly #stateDir: string;
	readonly #probe: LinuxProcessProbe;
	constructor(stateDir: string, probe = new LinuxProcessProbe()) {
		this.#stateDir = stateDir;
		this.#probe = probe;
	}

	async read(handle: string): Promise<ManagedRecord | null> {
		return readManagedRecord(await checkStateDir(this.#stateDir), handle);
	}

	async liveness(identity: ProcessIdentity): Promise<Liveness> {
		if ((await this.#probe.bootId()) !== identity.bootId) return "other_boot";
		const now = await this.#probe.read(identity.pid);
		if (!now) return "exited";
		if (now.identity.startTime !== identity.startTime) return "pid_reused";
		return now.zombie ? "exited" : "running";
	}
}

/**
 * Supervises one job under `handle`: records the intent with this process's
 * own identity, runs `file` with `args` (no shell, no input, its output
 * dropped), and records the receipt when it ends. If this process dies first,
 * no receipt is written, and a watch reports the outcome as unknown. It
 * forwards no signals and stops nothing: it only waits.
 */
export async function superviseManaged(options: { stateDir: string; handle: string; file: string; args: readonly string[]; probe?: LinuxProcessProbe }): Promise<CompletionReceipt> {
	const probe = options.probe ?? new LinuxProcessProbe();
	const self = await probe.read(process.pid);
	if (!self) throw new ManagedRecordError("identity_unreadable");
	await writeLaunchIntent(options.stateDir, { version: 1, handle: options.handle, supervisor: self.identity, launchedAt: Date.now() });
	const ended = await new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
		const child = spawn(options.file, [...options.args], { stdio: "ignore" });
		child.once("error", reject);
		child.once("exit", (exitCode, signal) => resolve({ exitCode: signal === null ? exitCode : null, signal }));
	});
	const receipt: CompletionReceipt = { version: 1, handle: options.handle, supervisor: self.identity, exitCode: ended.exitCode, signal: ended.signal, endedAt: Date.now() };
	await writeCompletionReceipt(options.stateDir, receipt);
	return receipt;
}
