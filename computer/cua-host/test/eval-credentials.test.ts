/**
 * The evaluation's credential channel (../eval-credentials.ts), run as the
 * program it is, over real files in a folder made for this run and removed
 * after: real RSA keys, real encryption, and management responses written
 * by the test in place of the cloud's. One test hands the preview file to
 * Wrangler's own --env-file loader, without starting anything. Nothing
 * leaves this machine, and no token here is used anywhere else.
 *
 *   pnpm --filter pim-cua-host test
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Relay } from "../../cua-bridge.ts";
import { createPrivateFile, type FileOperations } from "../eval-credentials.ts";

const CLI = fileURLToPath(new URL("../eval-credentials.ts", import.meta.url));
// Derived here from docs/cua-eval-credentials.md, not taken from the module.
const PREFIX = "pim-eval-credential.v1.";
const ALG = "RSA-OAEP-3072-SHA256";
const EVALUATION = "cua-eval-test";
const OWNER = "o_0123456789abcdefghijklmnop";
const OTHER_OWNER = "o_zyxwvutsrqponmlkjihgfedcba";
const URL_ = "https://bridge-eval.example.net:8443/pim";
const FAILURE = /^\{"event":"eval-credentials\.failed","command":"[a-z]+","reason":"[a-z-]+"\}\n$/;

/** Everything the program printed, and every token it made, so the last test can check none of the one is in the other. */
const printed: string[] = [];
const tokens: string[] = [];

type Result = { status: number | null; stdout: string; stderr: string };

function run(args: string[], input?: string | Buffer, wrapper: string[] = []): Result {
	const [command, ...rest] = wrapper.length ? wrapper : [process.execPath];
	const result = spawnSync(command as string, [...rest, ...(wrapper.length ? [process.execPath] : []), CLI, ...args], { input: input ?? "", encoding: "utf8" });
	printed.push(result.stdout, result.stderr);
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function refused(result: Result, command: string, reason: string): void {
	assert.deepEqual({ status: result.status, stdout: result.stdout, stderr: result.stderr }, { status: 1, stdout: "", stderr: `${JSON.stringify({ event: "eval-credentials.failed", command, reason })}\n` });
}

const mode = (file: string) => fs.lstatSync(file).mode & 0o7777;

let root = "";
/** A directory of this test run's, with `mode`. */
function dir(name: string, dirMode = 0o700): string {
	const made = path.join(root, name);
	fs.mkdirSync(made, { recursive: true });
	fs.chmodSync(made, dirMode);
	return made;
}

let counter = 0;
const fresh = (prefix: string) => `${prefix}-${++counter}`;

/** A file this test writes as a management response would be captured: new, 0600. */
function response(content: string | Buffer): string {
	const file = path.join(work, fresh("response"));
	fs.writeFileSync(file, content, { mode: 0o600, flag: "wx" });
	return file;
}

function keygen(at: string): { dir: string; fingerprint: string; publicPem: string } {
	const result = run(["keygen", "--dir", at]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	const { event, fingerprint, ...rest } = JSON.parse(result.stdout);
	assert.deepEqual({ event, rest }, { event: "eval-credentials.key", rest: {} });
	const publicPem = fs.readFileSync(path.join(at, "eval-key.pub.pem"), "utf8");
	// The fingerprint is the SHA-256 of the public key's SubjectPublicKeyInfo, worked out here on its own.
	const der = crypto.createPublicKey(publicPem).export({ type: "spki", format: "der" });
	assert.equal(fingerprint, crypto.createHash("sha256").update(der).digest("hex"));
	return { dir: at, fingerprint, publicPem };
}

let key: ReturnType<typeof keygen>;
let otherKey: ReturnType<typeof keygen>;
let work = "";
let guest = "";
let bridge = "";
let publicKeyFile = "";

/** Seals a new token on the "VM" for `evaluation` and `owner`; the token goes on the list the last test checks. */
function seal(evaluation = EVALUATION, owner = OWNER): { stdout: string; token: string; tokenFile: string } {
	const tokenFile = path.join(bridge, fresh("token"));
	const result = run(["seal", "--evaluation", evaluation, "--owner", owner, "--public-key", publicKeyFile, "--fingerprint", key.fingerprint, "--token-file", tokenFile]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	const token = fs.readFileSync(tokenFile, "latin1");
	tokens.push(token);
	return { stdout: result.stdout, token, tokenFile };
}

function open(responseFile: string, options: { out?: string; keyDir?: string; evaluation?: string; owner?: string; url?: string; fixture?: string } = {}, wrapper: string[] = []): Result & { out: string } {
	const out = options.out ?? path.join(work, fresh("preview-env"));
	const result = run(
		[
			"open",
			"--key-dir",
			options.keyDir ?? key.dir,
			"--response",
			responseFile,
			"--evaluation",
			options.evaluation ?? EVALUATION,
			"--owner",
			options.owner ?? OWNER,
			"--url",
			options.url ?? URL_,
			"--out",
			out,
			...(options.fixture === undefined ? [] : ["--fixture", options.fixture]),
		],
		undefined,
		wrapper,
	);
	return { ...result, out };
}

const envelopeOf = (stdout: string) => stdout.trim().slice(PREFIX.length);
const decode = (stdout: string) => JSON.parse(Buffer.from(envelopeOf(stdout), "base64url").toString("utf8")) as Record<string, unknown>;
const encodeText = (json: string) => PREFIX + Buffer.from(json, "utf8").toString("base64url");
const encode = (fields: Record<string, unknown>) => encodeText(JSON.stringify(fields));

/** Encrypts `plaintext` to a public key as the documented format says, with the label for the given context. */
function encrypt(publicPem: string, plaintext: Buffer, evaluation: string, owner: string, recipient: string): string {
	const oaepLabel = Buffer.from(`${PREFIX}\n${evaluation}\n${owner}\n${recipient}`);
	return crypto.publicEncrypt({ key: publicPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel }, plaintext).toString("base64url");
}

/** What the preview reads: the fixture's two settings, if asked for, and one line `CUA_BRIDGES='<JSON>'`. */
function previewBridges(file: string): unknown {
	const match = /^(?:PREVIEW_CUA_FIXTURE=seed\nPREVIEW_CUA_FIXTURE_OWNER=o_[0-9a-z]{26}\n)?CUA_BRIDGES='([^'\n\r\\$#`]*)'\n$/.exec(fs.readFileSync(file, "latin1"));
	assert.ok(match, "the preview file is the fixture's settings and one single-quoted CUA_BRIDGES line");
	return JSON.parse(match[1] as string);
}

/** The files in the work folder other than the responses the test wrote. */
const outputs = () => fs.readdirSync(work).filter((name) => !name.startsWith("response-"));

describe("evaluation credentials", { skip: process.geteuid?.() === 0 ? "refuses to run as root" : false }, () => {
	before(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cua-eval-cred-")));
		key = keygen(path.join(root, "key"));
		otherKey = keygen(path.join(root, "other-key"));
		work = dir("work");
		guest = dir("guest", 0o755);
		bridge = dir("guest/bridge");
		publicKeyFile = path.join(guest, "eval-key.pub.pem");
		fs.writeFileSync(publicKeyFile, key.publicPem, { mode: 0o644 });
	});

	after(() => {
		// None of the tokens made was ever printed, and no path either.
		assert.ok(tokens.length >= 5);
		for (const token of tokens) {
			const raw = Buffer.from(token, "base64url");
			for (const text of printed) {
				for (const form of [token, raw.toString("base64"), raw.toString("hex")]) assert.ok(!text.includes(form), "a token was printed");
				assert.ok(!text.includes(root), "a path was printed");
			}
		}
		fs.rmSync(root, { recursive: true, force: true });
		assert.equal(fs.existsSync(root), false);
	});

	it("carries a new token from the VM to the preview's environment file, encrypted on the way", () => {
		assert.equal(mode(key.dir), 0o700);
		assert.equal(mode(path.join(key.dir, "eval-key.pem")), 0o600);
		assert.equal(mode(path.join(key.dir, "eval-key.pub.pem")), 0o600);

		const { stdout, token, tokenFile } = seal();
		// The token file is what bridge.ts reads: the account's own, 0600, a token its relay takes.
		assert.equal(mode(tokenFile), 0o600);
		assert.equal(fs.statSync(tokenFile).uid, process.geteuid?.());
		assert.match(token, /^[A-Za-z0-9_-]{43}$/);
		assert.doesNotThrow(() => new Relay({ space: OWNER, token: fs.readFileSync(tokenFile, "utf8").trim(), path: "/pim", open: () => Promise.reject(new Error("unused")) }));
		// What comes back through the management channel is one line, the envelope, and carries no plaintext.
		assert.match(stdout, /^pim-eval-credential\.v1\.[A-Za-z0-9_-]+\n$/);
		const raw = Buffer.from(token, "base64url");
		for (const form of [token, raw.toString("base64"), raw.toString("hex")]) assert.ok(!stdout.includes(form));
		const envelope = decode(stdout);
		assert.deepEqual(Object.keys(envelope), ["v", "alg", "evaluation", "owner", "recipient", "ciphertext"]);
		assert.deepEqual({ ...envelope, ciphertext: undefined }, { v: 1, alg: ALG, evaluation: EVALUATION, owner: OWNER, recipient: key.fingerprint, ciphertext: undefined });
		assert.equal(Buffer.from(envelope.ciphertext as string, "base64url").length, 384);

		// As `az vm run-command invoke` answers, the envelope inside a JSON string with the script's other output.
		const azure = JSON.stringify(
			{ value: [{ code: "ProvisioningState/succeeded", displayStatus: "Provisioning succeeded", level: "Info", message: `Enable succeeded: \n[stdout]\nprovisioned\n${stdout}\n[stderr]\n`, time: null }] },
			null,
			2,
		);
		const captured = path.join(work, "response-azure");
		const capture = run(["capture", "--out", captured], azure);
		assert.deepEqual(capture, { status: 0, stdout: '{"event":"eval-credentials.captured"}\n', stderr: "" });
		assert.equal(mode(captured), 0o600);
		assert.equal(fs.readFileSync(captured, "utf8"), azure);

		const opened = open(captured, { out: path.join(work, "preview.env"), fixture: "seed" });
		assert.deepEqual({ ...opened, out: undefined }, { status: 0, stdout: `{"event":"eval-credentials.opened","evaluation":"${EVALUATION}"}\n`, stderr: "", out: undefined });
		assert.equal(mode(opened.out), 0o600);
		assert.equal(
			fs.readFileSync(opened.out, "utf8"),
			`PREVIEW_CUA_FIXTURE=seed\nPREVIEW_CUA_FIXTURE_OWNER=${OWNER}\nCUA_BRIDGES='{"${OWNER}":{"url":"${URL_}","token":"${token}"}}'\n`,
		);
		assert.deepEqual(previewBridges(opened.out), { [OWNER]: { url: URL_, token } });

		// The bare script output, and a managed Run Command's instance view, open the same way; without --fixture, only CUA_BRIDGES is written.
		const bare = open(response(stdout));
		assert.equal(bare.status, 0, bare.stderr);
		assert.equal(fs.readFileSync(bare.out, "utf8"), `CUA_BRIDGES='{"${OWNER}":{"url":"${URL_}","token":"${token}"}}'\n`);
		const managed = open(response(JSON.stringify({ name: "seal", instanceView: { executionState: "Succeeded", exitCode: 0, output: stdout, error: "" } })), { fixture: "seed" });
		assert.equal(managed.status, 0, managed.stderr);
		assert.equal(fs.readFileSync(managed.out, "utf8"), fs.readFileSync(opened.out, "utf8"));
		refused(open(response(stdout), { fixture: "off" }), "open", "fixture");
	});

	it("refuses an envelope for another evaluation, owner or key, or one changed on the way, and writes nothing", () => {
		const before_ = outputs();
		const { stdout, token } = seal();
		const envelope = decode(stdout);
		const file = response(stdout);
		refused(open(file, { evaluation: "cua-eval-other" }), "open", "context");
		refused(open(file, { owner: OTHER_OWNER }), "open", "context");
		refused(open(file, { keyDir: otherKey.dir }), "open", "recipient");

		// Fields rewritten to match what the operator expects don't match the label the token was encrypted under.
		refused(open(response(encode({ ...envelope, evaluation: "cua-eval-other" })), { evaluation: "cua-eval-other" }), "open", "decrypt");
		refused(open(response(encode({ ...envelope, owner: OTHER_OWNER })), { owner: OTHER_OWNER }), "open", "decrypt");
		refused(open(response(encode({ ...envelope, recipient: otherKey.fingerprint })), { keyDir: otherKey.dir }), "open", "decrypt");
		const flipped = Buffer.from(envelope.ciphertext as string, "base64url");
		flipped[100] = (flipped[100] as number) ^ 1;
		refused(open(response(encode({ ...envelope, ciphertext: flipped.toString("base64url") }))), "open", "decrypt");
		// Encrypted to the right key under another owner's label, with this owner's fields.
		const elsewhere = encrypt(key.publicPem, Buffer.from("A".repeat(42) + "E"), EVALUATION, OTHER_OWNER, key.fingerprint);
		refused(open(response(encode({ ...envelope, ciphertext: elsewhere }))), "open", "decrypt");

		// Decrypted, but not a token as the VM makes them: a quote, too short, or not canonical base64url.
		for (const plaintext of ["'".repeat(43), "A".repeat(42), "x".repeat(43)]) {
			const ciphertext = encrypt(key.publicPem, Buffer.from(plaintext), EVALUATION, OWNER, key.fingerprint);
			refused(open(response(encode({ ...envelope, ciphertext }))), "open", "token");
		}
		// A response that also carries the token in plaintext has leaked it, and isn't used.
		refused(open(response(`${stdout}${token}\n`)), "open", "response-plaintext");
		assert.deepEqual(outputs(), before_);
	});

	it("refuses a response without exactly one well-formed envelope", () => {
		const before_ = outputs();
		const { stdout } = seal();
		const envelope = decode(stdout);
		const json = JSON.stringify(envelope);
		const cases: [string | Buffer, string][] = [
			["Enable succeeded: \n[stdout]\n\n[stderr]\n", "envelope-missing"],
			[`${stdout}${stdout}`, "envelope-duplicate"],
			[`${stdout}${PREFIX}\n`, "envelope-duplicate"],
			[`${PREFIX}\n`, "envelope-size"],
			// The envelope must be a line of its own, or a JSON string's: nothing may run on from it or into it.
			[`${stdout.trim()}=\n`, "envelope-framing"],
			[`${stdout.trim()}==`, "envelope-framing"],
			[`${stdout.trim()}.\n`, "envelope-framing"],
			[`${stdout.trim()}%3D\n`, "envelope-framing"],
			[`${stdout.trim()} trailing\n`, "envelope-framing"],
			[`x${stdout}`, "envelope-framing"],
			[`=${stdout}`, "envelope-framing"],
			[JSON.stringify({ output: `${stdout.trim()}=\n` }), "envelope-framing"],
			[`${PREFIX}${"A".repeat(2049)}`, "envelope-size"],
			// "{}" is e30 in base64url; e31 decodes to the same bytes but isn't the canonical form.
			[`${PREFIX}e31`, "envelope-encoding"],
			[PREFIX + Buffer.from([0x7b, 0xff, 0x7d]).toString("base64url"), "envelope-encoding"],
			[encodeText("not json"), "envelope-schema"],
			[encodeText("[]"), "envelope-schema"],
			[encode({ ...envelope, extra: 1 }), "envelope-schema"],
			[encode({ ...envelope, url: URL_ }), "envelope-schema"],
			[encode({ ...envelope, ciphertext: undefined }), "envelope-schema"],
			[encode({ ...envelope, v: 2 }), "envelope-schema"],
			[encode({ ...envelope, evaluation: 7 }), "envelope-schema"],
			[encodeText(`{"v":1,"v":1,${json.slice('{"v":1,'.length)}`), "envelope-schema"],
			[encodeText(JSON.stringify(envelope, null, 1)), "envelope-schema"],
			[encode({ alg: envelope.alg, v: 1, evaluation: envelope.evaluation, owner: envelope.owner, recipient: envelope.recipient, ciphertext: envelope.ciphertext }), "envelope-schema"],
			[encode({ ...envelope, alg: "RSA-OAEP-2048-SHA1" }), "envelope-algorithm"],
			[encode({ ...envelope, ciphertext: Buffer.alloc(383, 1).toString("base64url") }), "envelope-encoding"],
			[encode({ ...envelope, ciphertext: `${envelope.ciphertext}=` }), "envelope-encoding"],
			[Buffer.concat([Buffer.from(stdout), Buffer.alloc(1024 * 1024)]), "response"],
		];
		for (const [content, reason] of cases) refused(open(response(content)), "open", reason);

		const big = path.join(work, "response-big");
		refused(run(["capture", "--out", big], Buffer.alloc(1024 * 1024 + 1, 0x61)), "capture", "response-size");
		refused(run(["capture", "--out", big], ""), "capture", "response-empty");
		assert.equal(fs.existsSync(big), false);
		assert.deepEqual(outputs(), before_);
	});

	it("refuses unsafe keys, responses and folders, and never writes over or through what is already there", () => {
		const outputsBefore = outputs();
		const { stdout } = seal();
		const good = response(stdout);

		// keygen makes a new private directory, or nothing.
		refused(run(["keygen", "--dir", key.dir]), "keygen", "key-directory-exists");
		const open777 = dir("open-777", 0o777);
		refused(run(["keygen", "--dir", path.join(open777, "key")]), "keygen", "key-directory");
		refused(run(["keygen", "--dir", "relative/key"]), "keygen", "key-directory");
		assert.deepEqual(fs.readdirSync(open777), []);

		// The private key: its directory and file must be this account's alone, and not links.
		const copy = (name: string) => {
			const at = dir(name);
			fs.copyFileSync(path.join(key.dir, "eval-key.pem"), path.join(at, "eval-key.pem"));
			fs.chmodSync(path.join(at, "eval-key.pem"), 0o600);
			return at;
		};
		const copied = open(good, { keyDir: copy("key-copy") });
		assert.equal(copied.status, 0);
		const loose = copy("key-loose");
		fs.chmodSync(loose, 0o750);
		refused(open(good, { keyDir: loose }), "open", "key");
		const readable = copy("key-readable");
		fs.chmodSync(path.join(readable, "eval-key.pem"), 0o640);
		refused(open(good, { keyDir: readable }), "open", "key");
		const linked = dir("key-linked");
		fs.symlinkSync(path.join(key.dir, "eval-key.pem"), path.join(linked, "eval-key.pem"));
		refused(open(good, { keyDir: linked }), "open", "key");
		fs.symlinkSync(key.dir, path.join(root, "key-link"));
		refused(open(good, { keyDir: path.join(root, "key-link") }), "open", "key");

		// The response: this account's alone, a regular file, not a link.
		const shared = response(stdout);
		fs.chmodSync(shared, 0o644);
		refused(open(shared), "open", "response");
		fs.symlinkSync(good, path.join(work, "response-link"));
		refused(open(path.join(work, "response-link")), "open", "response");
		execFileSync("mkfifo", ["-m", "600", path.join(work, "response-fifo")]);
		refused(open(path.join(work, "response-fifo")), "open", "response");
		fs.rmSync(path.join(work, "response-fifo"));
		refused(run(["capture", "--out", good], stdout), "capture", "response-exists");

		// The preview file: never over a file or through a link, only in a folder no one else can write.
		const existing = path.join(work, "existing");
		fs.writeFileSync(existing, "kept\n", { mode: 0o600 });
		refused(open(good, { out: existing }), "open", "output-exists");
		assert.equal(fs.readFileSync(existing, "utf8"), "kept\n");
		const target = path.join(root, "target");
		fs.symlinkSync(target, path.join(work, "dangling"));
		refused(open(good, { out: path.join(work, "dangling") }), "open", "output-exists");
		assert.equal(fs.existsSync(target), false);
		fs.symlinkSync(existing, path.join(work, "to-existing"));
		refused(open(good, { out: path.join(work, "to-existing") }), "open", "output-exists");
		assert.equal(fs.readFileSync(existing, "utf8"), "kept\n");
		const group = dir("group-writable", 0o770);
		refused(open(good, { out: path.join(group, "preview.env") }), "open", "output");
		// Only a folder no one else can enter, such as one outside the checkout made for the evaluation, not one like the checkout's own.
		const listable = dir("listable", 0o755);
		refused(open(good, { out: path.join(listable, "preview.env") }), "open", "output");
		fs.symlinkSync(work, path.join(root, "work-link"));
		refused(open(good, { out: path.join(root, "work-link", "preview.env") }), "open", "output");
		refused(open(good, { out: "preview.env" }), "open", "output");
		assert.deepEqual(fs.readdirSync(group), []);
		assert.deepEqual(fs.readdirSync(listable), []);

		// The bridge's address: the canonical HTTPS form only.
		for (const url of ["http://bridge.example.net/pim", "https://Bridge.example.net/pim", "https://bridge.example.net", "https://bridge.example.net/pim?x", "https://bridge.example.net/pim#x", "https://u:p@bridge.example.net/pim", "https://bridge.example.net/a/../pim", "https://bridge.example.net:443/pim", "https://bridge.example.net/pim'x", "https://bridge.example.net/pim$x"]) {
			refused(open(good, { url }), "open", "url");
		}

		// seal: the pinned key only, a token file that is new, in the bridge account's private folder.
		const sealWith = (overrides: Record<string, string>) => {
			const args = { evaluation: EVALUATION, owner: OWNER, "public-key": publicKeyFile, fingerprint: key.fingerprint, "token-file": path.join(bridge, fresh("token")), ...overrides };
			return run(["seal", ...Object.entries(args).flatMap(([name, value]) => [`--${name}`, value])]);
		};
		const existingToken = path.join(bridge, "existing-token");
		fs.writeFileSync(existingToken, "kept\n", { mode: 0o600 });
		refused(sealWith({ "token-file": existingToken }), "seal", "token-exists");
		assert.equal(fs.readFileSync(existingToken, "utf8"), "kept\n");
		fs.symlinkSync(path.join(root, "token-target"), path.join(bridge, "token-link"));
		refused(sealWith({ "token-file": path.join(bridge, "token-link") }), "seal", "token-exists");
		assert.equal(fs.existsSync(path.join(root, "token-target")), false);
		const tokensBefore = fs.readdirSync(bridge).sort();
		refused(sealWith({ fingerprint: otherKey.fingerprint }), "seal", "fingerprint");
		refused(sealWith({ fingerprint: "not-hex" }), "seal", "fingerprint");
		refused(sealWith({ evaluation: "Has Spaces" }), "seal", "context");
		refused(sealWith({ owner: "o_short" }), "seal", "context");
		fs.chmodSync(publicKeyFile, 0o664);
		refused(sealWith({}), "seal", "public-key");
		fs.chmodSync(publicKeyFile, 0o644);
		const small = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
		const smallFile = path.join(guest, "small.pub.pem");
		fs.writeFileSync(smallFile, small.export({ type: "spki", format: "pem" }), { mode: 0o644 });
		const smallFingerprint = crypto.createHash("sha256").update(small.export({ type: "spki", format: "der" })).digest("hex");
		refused(sealWith({ "public-key": smallFile, fingerprint: smallFingerprint }), "seal", "public-key");
		assert.deepEqual(fs.readdirSync(bridge).sort(), tokensBefore);
		const openBridge = dir("guest/open-bridge", 0o755);
		refused(sealWith({ "token-file": path.join(openBridge, "token") }), "seal", "token-directory");
		assert.deepEqual(fs.readdirSync(openBridge), []);

		// Usage repeats nothing it was given.
		const usage = run(["open", "--token", "do-not-echo-this-value", "--out", "/nowhere"]);
		assert.equal(usage.status, 2);
		assert.ok(!usage.stderr.includes("do-not-echo-this-value") && !usage.stderr.includes("/nowhere"));
		assert.equal(run(["unknown"]).status, 2);

		// Only what the test made itself, and the one preview file opened with the copied key.
		assert.deepEqual(outputs().sort(), [...outputsBefore, "dangling", "existing", "to-existing", path.basename(copied.out)].sort());
	});

	it("publishes the preview file once when several open it at the same time", async () => {
		const { stdout, token } = seal();
		const file = response(stdout);
		const out = path.join(work, "concurrent.env");
		const args = ["open", "--key-dir", key.dir, "--response", file, "--evaluation", EVALUATION, "--owner", OWNER, "--url", URL_, "--out", out];
		const results = await Promise.all(
			Array.from(
				{ length: 6 },
				() =>
					new Promise<Result>((resolve) => {
						const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
						let stdout_ = "";
						let stderr = "";
						child.stdout.on("data", (chunk) => (stdout_ += chunk));
						child.stderr.on("data", (chunk) => (stderr += chunk));
						child.on("close", (status) => {
							printed.push(stdout_, stderr);
							resolve({ status, stdout: stdout_, stderr });
						});
					}),
			),
		);
		assert.equal(results.filter((result) => result.status === 0).length, 1);
		for (const result of results.filter((result) => result.status !== 0)) refused(result, "open", "output-exists");
		assert.equal(mode(out), 0o600);
		assert.deepEqual(previewBridges(out), { [OWNER]: { url: URL_, token } });
	});

	it("leaves no part of the preview file behind when writing it fails", { skip: fs.existsSync("/usr/bin/prlimit") ? false : "needs prlimit" }, () => {
		const { stdout } = seal();
		// A long address makes the file longer than the 1 KiB the process may write, so the write fails partway.
		const url = `https://bridge-eval.example.net/${"segment/".repeat(150)}pim`;
		const result = open(response(stdout), { url }, ["/usr/bin/prlimit", "--fsize=1024", "--"]);
		refused(result, "open", "output-write");
		assert.equal(fs.existsSync(result.out), false);
		assert.ok(!outputs().includes(path.basename(result.out)));
	});

	it("says when a failed write may have left a file behind", () => {
		const at = dir("io");
		const failure = (code: string) => Object.assign(new Error(code), { code });
		/** Writes the first 10 bytes for real, then fails, as a full disk would. */
		const partway: FileOperations["writeSync"] = ((descriptor: number, buffer: Buffer, offset: number) => {
			if (offset === 0) return fs.writeSync(descriptor, buffer, 0, 10);
			throw failure("ENOSPC");
		}) as FileOperations["writeSync"];
		const content = Buffer.from("x".repeat(100));
		const attempt = (name: string, overrides: Partial<FileOperations>) => {
			const file = path.join(at, name);
			try {
				createPrivateFile(file, content, "output", true, { ...fs, writeSync: partway, ...overrides } as FileOperations);
			} catch (error) {
				return { file, reason: (error as { reason?: string }).reason };
			}
			assert.fail("the write was meant to fail");
		};
		// Emptied and removed: nothing left.
		const plain = attempt("plain", {});
		assert.equal(plain.reason, "output-write");
		assert.equal(fs.existsSync(plain.file), false);
		// Emptying fails, removing still happens.
		const noTruncate = attempt("no-truncate", { ftruncateSync: () => { throw failure("EIO"); } });
		assert.equal(noTruncate.reason, "output-write");
		assert.equal(fs.existsSync(noTruncate.file), false);
		// Removing fails: an empty file is left, and the refusal says so.
		const noUnlink = attempt("no-unlink", { unlinkSync: () => { throw failure("EIO"); } });
		assert.deepEqual([noUnlink.reason, fs.statSync(noUnlink.file).size], ["output-write-residue", 0]);
		// Both fail: what was written is left, and the refusal says so.
		const neither = attempt("neither", { ftruncateSync: () => { throw failure("EIO"); }, unlinkSync: () => { throw failure("EIO"); } });
		assert.deepEqual([neither.reason, fs.readFileSync(neither.file, "utf8")], ["output-write-residue", "x".repeat(10)]);
		// The path can't be shown to be this call's file: it is left alone, and the refusal says so.
		const unchecked = attempt("unchecked", { lstatSync: (() => { throw failure("EIO"); }) as FileOperations["lstatSync"] });
		assert.deepEqual([unchecked.reason, fs.existsSync(unchecked.file)], ["output-write-residue", true]);
		fs.rmSync(at, { recursive: true });
	});

	it("leaves the token file and says so when its envelope can't be written", async () => {
		const tokenFile = path.join(bridge, fresh("token"));
		const args = ["seal", "--evaluation", EVALUATION, "--owner", OWNER, "--public-key", publicKeyFile, "--fingerprint", key.fingerprint, "--token-file", tokenFile];
		const result = await new Promise<Result>((resolve) => {
			const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
			// Nothing reads the output, so writing the envelope fails (EPIPE).
			child.stdout.destroy();
			let stderr = "";
			child.stderr.on("data", (chunk) => (stderr += chunk));
			child.on("close", (status) => {
				printed.push(stderr);
				resolve({ status, stdout: "", stderr });
			});
		});
		refused(result, "seal", "stdout");
		assert.equal(mode(tokenFile), 0o600);
		tokens.push(fs.readFileSync(tokenFile, "latin1"));
	});

	it("gives the preview exactly CUA_BRIDGES and the fixture's settings through Wrangler's --env-file loader, as hidden secrets", async () => {
		const { stdout, token } = seal();
		const opened = open(response(stdout), { out: path.join(dir("preview-cua"), "preview.env"), fixture: "seed" });
		assert.equal(opened.status, 0, opened.stderr);
		const logs = dir("wrangler-logs");
		const saved = { path: process.env.WRANGLER_LOG_PATH, level: process.env.WRANGLER_LOG };
		process.env.WRANGLER_LOG_PATH = logs;
		process.env.WRANGLER_LOG = "debug";
		const said: string[] = [];
		const write = { out: process.stdout.write, err: process.stderr.write };
		let vars: Record<string, { type: string; value: unknown }>;
		try {
			const wrangler = await import("wrangler");
			// What `wrangler dev --config wrangler.preview.jsonc --env-file <file>` binds (`getBindings` in Wrangler 4.148), without starting it.
			const config = wrangler.unstable_readConfig({ config: path.resolve(fileURLToPath(new URL("../../..", import.meta.url)), "wrangler.preview.jsonc") });
			const capture = (chunk: string | Uint8Array) => (said.push(String(chunk)), true);
			process.stdout.write = capture as typeof process.stdout.write;
			process.stderr.write = capture as typeof process.stderr.write;
			try {
				vars = wrangler.unstable_getVarsForDev(config.userConfigPath, [opened.out], config.vars, undefined, false, config.secrets) as typeof vars;
			} finally {
				process.stdout.write = write.out;
				process.stderr.write = write.err;
			}
		} finally {
			for (const [name, value] of [["WRANGLER_LOG_PATH", saved.path], ["WRANGLER_LOG", saved.level]] as const) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
		// Wrangler appends to its log file in the background, so the test waits for what it said to arrive there.
		const readLogs = () => fs.readdirSync(logs).map((name) => fs.readFileSync(path.join(logs, name), "utf8"));
		for (const deadline = Date.now() + 10_000; !readLogs().join("").includes("Using secrets defined in"); ) {
			assert.ok(Date.now() < deadline, "Wrangler's log never said which file it read");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		// Exactly these values, with Wrangler's `$` expansion leaving them as they are, each a secret, which Wrangler shows as "(hidden)".
		assert.deepEqual(vars.CUA_BRIDGES, { type: "secret_text", value: JSON.stringify({ [OWNER]: { url: URL_, token } }) });
		assert.deepEqual(vars.PREVIEW_CUA_FIXTURE, { type: "secret_text", value: "seed" });
		assert.deepEqual(vars.PREVIEW_CUA_FIXTURE_OWNER, { type: "secret_text", value: OWNER });
		// What Wrangler said, and its debug log, name the file but hold no token.
		const logged = readLogs();
		assert.ok(said.some((line) => line.includes("Using secrets defined in")));
		for (const text of [...said, ...logged]) assert.ok(!text.includes(token));
	});

	it("prints only fixed failures", () => {
		for (const text of printed) {
			if (text.startsWith('{"event":"eval-credentials.failed"')) assert.match(text, FAILURE);
		}
	});
});
