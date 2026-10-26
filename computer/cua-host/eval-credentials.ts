/**
 * Carries a Cua evaluation bridge's token from a new VM to the local
 * preview that qualifies it (docs/cua-eval-credentials.md), so the token
 * is in plaintext only in the bridge's own token file on the VM and in the
 * preview's private `.dev.vars` on the operator's machine. It is for one
 * evaluation, not for a deployment, and nothing in Pim imports it.
 *
 *   node eval-credentials.ts keygen --dir <new private directory>                 (operator's machine)
 *   node eval-credentials.ts seal --evaluation <id> --owner <o_…> \
 *     --public-key <file> --fingerprint <sha256 hex> --token-file <file>          (VM, as the bridge's account)
 *   node eval-credentials.ts capture --out <file> < management-response           (operator's machine)
 *   node eval-credentials.ts open --key-dir <dir> --response <file> --evaluation <id> \
 *     --owner <o_…> --url <https://…> --out <.dev.vars>                           (operator's machine)
 *
 * `keygen` makes an RSA-3072 key pair in a new 0700 directory, and prints
 * only the public key's fingerprint; only the public key leaves the machine.
 * `seal` makes a new token in the format bridge.ts reads, encrypts it to
 * that public key with RSA-OAEP (SHA-256), whose label binds it to the
 * evaluation, the space's owner and the key, creates the token file, and
 * then prints one line, the envelope, which is all that comes back through
 * the cloud's management channel. `capture` stores that channel's response
 * in a new 0600 file. `open` finds exactly one envelope in it, checks it
 * against what the operator expects, decrypts it, and creates the preview's
 * `.dev.vars` holding `CUA_BRIDGES` for that one space.
 *
 * Every file it writes is created new (never over anything, never through
 * a link) with mode 0600 from its first byte, in a directory of this
 * account's that no one else can write; a failure after creating one
 * removes it. Everything is checked before anything is created. It runs no
 * other program. What it prints is fixed: an event name, the fingerprint or
 * the evaluation's ID, or a failure's reason, never a path, a token, or
 * what was thrown. Importing it does nothing.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** What starts an envelope wherever it is printed; base64url follows, so it reads the same inside a JSON string. */
export const ENVELOPE_PREFIX = "pim-eval-credential.v1.";
export const ALGORITHM = "RSA-OAEP-3072-SHA256";
/** The most bytes of a management response `capture` keeps and `open` reads. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ENVELOPE_CHARS = 2048;
const MAX_KEY_BYTES = 16 * 1024;
const MODULUS_BITS = 3072;
const CIPHERTEXT_BYTES = MODULUS_BITS / 8;
/** A token is 32 random bytes in base64url: 43 characters, within what bridge.ts and Pim take (printable ASCII, 32 to 4096). */
const TOKEN_BYTES = 32;
const TOKEN_CHARS = 43;
const PRIVATE_KEY_FILE = "eval-key.pem";
const PUBLIC_KEY_FILE = "eval-key.pub.pem";

const EVALUATION = /^[a-z0-9][a-z0-9-]{2,62}$/;
/** An owner ID, as src/cua.ts and ../cua-bridge.ts check it. */
const OWNER = /^o_[0-9a-z]{26}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/**
 * A bridge's address: HTTPS, a lowercase host name or bracketed IPv6
 * address, an optional port, and a path of unreserved characters, already
 * in the form `URL` gives it. That is narrower than src/cua.ts takes (no
 * credentials, query or fragment), so it can go into JSON and a
 * single-quoted dotenv value unescaped.
 */
const BRIDGE_URL = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~-]*)+$/;

/** A refusal with a fixed reason, the only thing said about it. */
class Refusal extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(reason);
		this.reason = reason;
	}
}

const euid = (): number => process.geteuid?.() ?? -1;

/** The label RSA-OAEP binds the token to: the format, the evaluation, the owner and the recipient key's fingerprint. */
function label(evaluation: string, owner: string, recipient: string): Buffer {
	return Buffer.from(`${ENVELOPE_PREFIX}\n${evaluation}\n${owner}\n${recipient}`, "utf8");
}

/** The SHA-256 of a public key's SubjectPublicKeyInfo (DER), in lowercase hex. */
function fingerprintOf(key: crypto.KeyObject): string {
	return crypto.createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

/** Refuses any key but RSA-3072 with exponent 65537. */
function checkKey(key: crypto.KeyObject, reason: string): void {
	const details = key.asymmetricKeyDetails;
	if (key.asymmetricKeyType !== "rsa" || details?.modulusLength !== MODULUS_BITS || details.publicExponent !== 65537n) throw new Refusal(reason);
}

function checkAbsolute(file: string, reason: string): void {
	if (!path.isAbsolute(file) || path.normalize(file) !== file || file.includes("\0") || (file !== "/" && file.endsWith("/"))) throw new Refusal(reason);
}

/**
 * Checks `dir` and every directory above it: each a directory, not a link,
 * owned by root or this account, and writable by no one else unless it is
 * sticky (as /tmp is). Returns `dir`'s own status for the caller's checks.
 */
function trustedDirectory(dir: string, reason: string): fs.Stats {
	checkAbsolute(dir, reason);
	let current = "/";
	let status: fs.Stats | undefined;
	for (const part of ["", ...dir.split("/").filter(Boolean)]) {
		current = path.join(current, part);
		try {
			status = fs.lstatSync(current);
		} catch {
			throw new Refusal(reason);
		}
		if (!status.isDirectory() || (status.uid !== 0 && status.uid !== euid())) throw new Refusal(reason);
		if ((status.mode & 0o022) !== 0 && (status.mode & 0o1000) === 0) throw new Refusal(reason);
	}
	if (!status) throw new Refusal(reason);
	return status;
}

/** A directory of this account's that no one else can write; `private_` also lets no one else read or enter it. */
function ownDirectory(dir: string, reason: string, private_: boolean): void {
	const status = trustedDirectory(dir, reason);
	if (status.uid !== euid() || (status.mode & (private_ ? 0o077 : 0o022)) !== 0) throw new Refusal(reason);
}

/**
 * Reads a regular file, never through a link, of at most `maxBytes`, in a
 * trusted directory. `owner` is who must own it, and `mask` the mode bits
 * it must not have.
 */
function readFile(file: string, reason: string, maxBytes: number, owner: "self" | "self-or-root", mask: number): Buffer {
	checkAbsolute(file, reason);
	trustedDirectory(path.dirname(file), reason);
	let descriptor: number;
	try {
		descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	} catch {
		throw new Refusal(reason);
	}
	try {
		const status = fs.fstatSync(descriptor);
		const owned = status.uid === euid() || (owner === "self-or-root" && status.uid === 0);
		if (!status.isFile() || !owned || (status.mode & mask) !== 0 || status.size > maxBytes) throw new Refusal(reason);
		const buffer = Buffer.alloc(maxBytes + 1);
		let length = 0;
		for (;;) {
			const read = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
			if (read === 0) break;
			length += read;
			if (length > maxBytes) throw new Refusal(reason);
		}
		return buffer.subarray(0, length);
	} catch (error) {
		throw error instanceof Refusal ? error : new Refusal(reason);
	} finally {
		fs.closeSync(descriptor);
	}
}

/**
 * Creates `file` with `content`: new (`O_EXCL`, so nothing already there,
 * a link included, is followed or replaced, and of two writers only one
 * creates it), mode 0600 from its first byte, in a directory of this
 * account's. If anything fails after it is created, it is emptied and
 * removed, so no part of `content` stays behind.
 */
function create(file: string, content: Buffer, reason: string, private_: boolean): void {
	checkAbsolute(file, reason);
	ownDirectory(path.dirname(file), reason, private_);
	let descriptor: number;
	try {
		descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
	} catch (error) {
		throw new Refusal((error as NodeJS.ErrnoException).code === "EEXIST" ? `${reason}-exists` : reason);
	}
	try {
		fs.fchmodSync(descriptor, 0o600);
		const status = fs.fstatSync(descriptor);
		if (!status.isFile() || status.uid !== euid() || (status.mode & 0o7777) !== 0o600) throw new Refusal(reason);
		let written = 0;
		while (written < content.length) written += fs.writeSync(descriptor, content, written, content.length - written);
		fs.fsyncSync(descriptor);
	} catch {
		try {
			const made = fs.fstatSync(descriptor);
			const there = fs.lstatSync(file);
			if (made.dev === there.dev && made.ino === there.ino) {
				fs.ftruncateSync(descriptor, 0);
				fs.unlinkSync(file);
			}
		} catch {
			// Nothing more can be done for it here; the failure below says so.
		}
		fs.closeSync(descriptor);
		throw new Refusal(`${reason}-write`);
	}
	fs.closeSync(descriptor);
	syncDirectory(path.dirname(file));
}

/** Makes a new entry in a directory durable; a failure to do so changes nothing that was written. */
function syncDirectory(dir: string): void {
	try {
		const descriptor = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
		try {
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
	} catch {
		// Durability only.
	}
}

/** Whether `bytes` is a token as `seal` makes them: 43 base64url characters that are the canonical form of 32 bytes. */
function isToken(bytes: Buffer): boolean {
	if (bytes.length !== TOKEN_CHARS) return false;
	for (const byte of bytes) {
		const ok = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x5f;
		if (!ok) return false;
	}
	const raw = Buffer.from(bytes.toString("latin1"), "base64url");
	const canonical = raw.length === TOKEN_BYTES && raw.toString("base64url") === bytes.toString("latin1");
	raw.fill(0);
	return canonical;
}

/** Decodes base64url only in its one canonical form. */
function base64url(text: string, reason: string): Buffer {
	if (!BASE64URL.test(text)) throw new Refusal(reason);
	const bytes = Buffer.from(text, "base64url");
	if (bytes.toString("base64url") !== text) throw new Refusal(reason);
	return bytes;
}

type Envelope = { v: 1; alg: string; evaluation: string; owner: string; recipient: string; ciphertext: string };

/** The envelope's JSON, with its fields in this order and no whitespace; `open` takes no other form. */
function envelopeJson(envelope: Envelope): string {
	const { v, alg, evaluation, owner, recipient, ciphertext } = envelope;
	return JSON.stringify({ v, alg, evaluation, owner, recipient, ciphertext });
}

/** The one envelope in a management response; none, more than one, or one out of bounds or form is refused. */
function findEnvelope(response: Buffer): Envelope {
	// Latin-1 maps each byte to one character, so any bytes can be searched; the envelope itself is ASCII.
	const text = response.toString("latin1");
	const first = text.indexOf(ENVELOPE_PREFIX);
	if (first < 0) throw new Refusal("envelope-missing");
	if (text.indexOf(ENVELOPE_PREFIX, first + 1) >= 0) throw new Refusal("envelope-duplicate");
	const run = /^[A-Za-z0-9_-]*/.exec(text.slice(first + ENVELOPE_PREFIX.length, first + ENVELOPE_PREFIX.length + MAX_ENVELOPE_CHARS + 1))?.[0] ?? "";
	if (run.length === 0 || run.length > MAX_ENVELOPE_CHARS) throw new Refusal("envelope-size");
	let json: string;
	try {
		json = new TextDecoder("utf-8", { fatal: true }).decode(base64url(run, "envelope-encoding"));
	} catch {
		throw new Refusal("envelope-encoding");
	}
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new Refusal("envelope-schema");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Refusal("envelope-schema");
	const fields = value as Record<string, unknown>;
	const keys = Object.keys(fields);
	const strings = ["alg", "evaluation", "owner", "recipient", "ciphertext"].every((key) => typeof fields[key] === "string");
	if (keys.length !== 6 || fields.v !== 1 || !strings) throw new Refusal("envelope-schema");
	const envelope = fields as Envelope;
	// Only the exact serialization is taken, so a repeated key, reordered fields or extra whitespace are refused, not resolved.
	if (envelopeJson(envelope) !== json) throw new Refusal("envelope-schema");
	if (envelope.alg !== ALGORITHM) throw new Refusal("envelope-algorithm");
	return envelope;
}

function checkBridgeUrl(value: string): void {
	if (value.length > 2048 || !BRIDGE_URL.test(value)) throw new Refusal("url");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Refusal("url");
	}
	if (url.href !== value || url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Refusal("url");
}

function keygen(dir: string): string {
	checkAbsolute(dir, "key-directory");
	trustedDirectory(path.dirname(dir), "key-directory");
	try {
		fs.mkdirSync(dir, { mode: 0o700 });
	} catch (error) {
		throw new Refusal((error as NodeJS.ErrnoException).code === "EEXIST" ? "key-directory-exists" : "key-directory");
	}
	try {
		fs.chmodSync(dir, 0o700);
		ownDirectory(dir, "key-directory", true);
		const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: MODULUS_BITS, publicExponent: 0x10001 });
		const pem = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }));
		try {
			create(path.join(dir, PRIVATE_KEY_FILE), pem, "key", true);
		} finally {
			pem.fill(0);
		}
		create(path.join(dir, PUBLIC_KEY_FILE), Buffer.from(publicKey.export({ type: "spki", format: "pem" })), "key", true);
		return fingerprintOf(publicKey);
	} catch (error) {
		// Only what this call made is removed: the directory was new, so nothing else is in it.
		for (const name of [PRIVATE_KEY_FILE, PUBLIC_KEY_FILE]) fs.rmSync(path.join(dir, name), { force: true });
		fs.rmdirSync(dir);
		throw error;
	}
}

function seal(options: { evaluation: string; owner: string; publicKey: string; fingerprint: string; tokenFile: string }): string {
	const { evaluation, owner, fingerprint, tokenFile } = options;
	if (!EVALUATION.test(evaluation) || !OWNER.test(owner)) throw new Refusal("context");
	if (!FINGERPRINT.test(fingerprint)) throw new Refusal("fingerprint");
	let publicKey: crypto.KeyObject;
	try {
		publicKey = crypto.createPublicKey(readFile(options.publicKey, "public-key", MAX_KEY_BYTES, "self-or-root", 0o022));
	} catch {
		throw new Refusal("public-key");
	}
	checkKey(publicKey, "public-key");
	if (fingerprintOf(publicKey) !== fingerprint) throw new Refusal("fingerprint");
	checkAbsolute(tokenFile, "token");
	ownDirectory(path.dirname(tokenFile), "token-directory", true);
	try {
		fs.lstatSync(tokenFile);
		throw new Refusal("token-exists");
	} catch (error) {
		if (error instanceof Refusal) throw error;
	}
	const raw = crypto.randomBytes(TOKEN_BYTES);
	const token = Buffer.from(raw.toString("base64url"), "latin1");
	raw.fill(0);
	try {
		const ciphertext = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: label(evaluation, owner, fingerprint) }, token);
		const envelope = envelopeJson({ v: 1, alg: ALGORITHM, evaluation, owner, recipient: fingerprint, ciphertext: ciphertext.toString("base64url") });
		// The token file is made last, once the envelope is ready, so a failure before leaves no token behind.
		create(tokenFile, token, "token", true);
		return ENVELOPE_PREFIX + Buffer.from(envelope, "utf8").toString("base64url");
	} finally {
		token.fill(0);
	}
}

async function capture(out: string): Promise<void> {
	checkAbsolute(out, "response");
	ownDirectory(path.dirname(out), "response", false);
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of process.stdin) {
		length += (chunk as Buffer).length;
		if (length > MAX_RESPONSE_BYTES) throw new Refusal("response-size");
		chunks.push(chunk as Buffer);
	}
	if (length === 0) throw new Refusal("response-empty");
	create(out, Buffer.concat(chunks), "response", false);
}

function open(options: { keyDir: string; response: string; evaluation: string; owner: string; url: string; out: string }): void {
	const { evaluation, owner, url, out } = options;
	if (!EVALUATION.test(evaluation) || !OWNER.test(owner)) throw new Refusal("context");
	checkBridgeUrl(url);
	checkAbsolute(out, "output");
	ownDirectory(options.keyDir, "key", true);
	const pem = readFile(path.join(options.keyDir, PRIVATE_KEY_FILE), "key", MAX_KEY_BYTES, "self", 0o077);
	let privateKey: crypto.KeyObject;
	try {
		privateKey = crypto.createPrivateKey(pem);
	} catch {
		throw new Refusal("key");
	} finally {
		pem.fill(0);
	}
	checkKey(privateKey, "key");
	const recipient = fingerprintOf(crypto.createPublicKey(privateKey));
	const response = readFile(options.response, "response", MAX_RESPONSE_BYTES, "self", 0o077);
	const envelope = findEnvelope(response);
	if (envelope.evaluation !== evaluation || envelope.owner !== owner) throw new Refusal("context");
	if (envelope.recipient !== recipient) throw new Refusal("recipient");
	const ciphertext = base64url(envelope.ciphertext, "envelope-encoding");
	if (ciphertext.length !== CIPHERTEXT_BYTES) throw new Refusal("envelope-encoding");
	let token: Buffer;
	try {
		// The label is made from what the operator expects, not from what the envelope says.
		token = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: label(evaluation, owner, recipient) }, ciphertext);
	} catch {
		throw new Refusal("decrypt");
	}
	let content: Buffer | undefined;
	try {
		if (!isToken(token)) throw new Refusal("token");
		// A token that came back in plaintext beside its envelope has leaked through the management channel; it is not used.
		if (response.includes(token)) throw new Refusal("response-plaintext");
		// The owner, address and token are checked to have no character JSON or a single-quoted dotenv value would treat specially
		// (no quote, backslash, `$`, `#` or line break), so the value is the JSON `bridgeFor` in src/cua.ts reads, unescaped.
		content = Buffer.concat([Buffer.from(`CUA_BRIDGES='{"${owner}":{"url":"${url}","token":"`, "latin1"), token, Buffer.from(`"}}'\n`, "latin1")]);
		create(out, content, "output", false);
	} finally {
		token.fill(0);
		content?.fill(0);
	}
}

const USAGE = `Carries a Cua evaluation bridge's token to the local preview, encrypted on the way. See docs/cua-eval-credentials.md.

  node eval-credentials.ts keygen --dir <new directory>
  node eval-credentials.ts seal --evaluation <id> --owner <o_…> --public-key <file> --fingerprint <hex> --token-file <file>
  node eval-credentials.ts capture --out <file> < response
  node eval-credentials.ts open --key-dir <dir> --response <file> --evaluation <id> --owner <o_…> --url <https://…> --out <file>`;

const COMMANDS = {
	keygen: ["dir"],
	seal: ["evaluation", "owner", "public-key", "fingerprint", "token-file"],
	capture: ["out"],
	open: ["key-dir", "response", "evaluation", "owner", "url", "out"],
} as const;

async function main(argv: string[]): Promise<void> {
	const command = argv[0] as keyof typeof COMMANDS;
	const names: readonly string[] | undefined = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
	let values: Record<string, string | undefined> = {};
	try {
		if (!names) throw new Error();
		const parsed = parseArgs({ args: argv.slice(1), options: Object.fromEntries(names.map((name) => [name, { type: "string" as const }])), strict: true, allowPositionals: false });
		values = parsed.values as Record<string, string | undefined>;
		if (names.some((name) => !values[name])) throw new Error();
	} catch {
		// The arguments are never repeated back.
		process.stderr.write(`${USAGE}\n`);
		process.exit(2);
	}
	const value = (name: string) => values[name] as string;
	try {
		if (euid() === 0) throw new Refusal("root");
		if (command === "keygen") {
			const fingerprint = keygen(value("dir"));
			process.stdout.write(`${JSON.stringify({ event: "eval-credentials.key", fingerprint })}\n`);
		} else if (command === "seal") {
			const envelope = seal({ evaluation: value("evaluation"), owner: value("owner"), publicKey: value("public-key"), fingerprint: value("fingerprint"), tokenFile: value("token-file") });
			fs.writeSync(1, `${envelope}\n`);
		} else if (command === "capture") {
			await capture(value("out"));
			process.stdout.write(`${JSON.stringify({ event: "eval-credentials.captured" })}\n`);
		} else {
			open({ keyDir: value("key-dir"), response: value("response"), evaluation: value("evaluation"), owner: value("owner"), url: value("url"), out: value("out") });
			process.stdout.write(`${JSON.stringify({ event: "eval-credentials.opened", evaluation: value("evaluation") })}\n`);
		}
	} catch (error) {
		// What was thrown may carry a path or worse, so only the fixed reason is said.
		process.stderr.write(`${JSON.stringify({ event: "eval-credentials.failed", command, reason: error instanceof Refusal ? error.reason : "internal" })}\n`);
		process.exit(1);
	}
}

// Run as a program, never when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main(process.argv.slice(2));
