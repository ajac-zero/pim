// Live acceptance of "Add another device" against a deployed Pimling, with a disposable account.
//
//   node scripts/live-device-smoke.mjs --domain pimling.example.com --username smoke-dev4 \
//     --invite-file ./invite [--desktop-port 9351 --phone-port 9352] [--artifacts ./artifacts]
//
// Needs two Chrome profiles started with --remote-debugging-port (the desktop and the phone), Node
// 22+ for WebSocket, and Python with zxing-cpp and pillow to decode the QR code from a screenshot,
// as a phone's camera would. Each profile gets its own virtual passkey authenticator.
//
// It never prints the invite, setup or device codes. The disposable account is deleted at the end,
// and also when a check fails or the script throws; if that cleanup fails too, it says so and exits
// with status 2. Run it from a network that hasn't used up the deployment's per-address
// registration limit for the day.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
	options: {
		domain: { type: "string" },
		username: { type: "string" },
		"invite-file": { type: "string" },
		"desktop-port": { type: "string", default: "9351" },
		"phone-port": { type: "string", default: "9352" },
		artifacts: { type: "string", default: "./artifacts" },
		// How long to wait for every Worker to stop trusting a cached account (30 s), plus margin.
		"cache-wait-ms": { type: "string", default: "40000" },
		// For a local preview: "http" and a port, such as --scheme http --port 8787.
		scheme: { type: "string", default: "https" },
		port: { type: "string" },
	},
});
for (const required of ["domain", "username", "invite-file"]) {
	if (!args[required]) {
		console.error(`--${required} is required`);
		process.exit(64);
	}
}
const DOMAIN = args.domain;
const USER = args.username;
const SUFFIX = args.port ? `:${args.port}` : "";
const FRONT = `${args.scheme}://${DOMAIN}${SUFFIX}`;
const HOST = `${args.scheme}://${USER}.${DOMAIN}${SUFFIX}`;
const INVITE = readFileSync(args["invite-file"], "utf8").trim();
mkdirSync(args.artifacts, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
	return ok;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A tab in a Chrome profile, with its own virtual passkey authenticator. */
async function tab(port, mobile) {
	const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
	const ws = new WebSocket(webSocketDebuggerUrl);
	let id = 0;
	const pending = new Map();
	ws.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) reject(new Error(message.error.message));
			else resolve(message.result);
		}
	});
	await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const n = ++id;
			pending.set(n, { resolve, reject });
			ws.send(JSON.stringify({ id: n, method, params }));
		});
	await send("Page.enable");
	await send("Runtime.enable");
	await send("WebAuthn.enable", { enableUI: false });
	const { authenticatorId } = await send("WebAuthn.addVirtualAuthenticator", {
		options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
	});
	await send(
		"Emulation.setDeviceMetricsOverride",
		mobile ? { width: 390, height: 844, deviceScaleFactor: 3, mobile: true } : { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false },
	);
	const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
	const until = async (expression, ms = 15_000) => {
		for (let elapsed = 0; elapsed < ms; elapsed += 250) {
			if (await evaluate(expression).catch(() => false)) return true;
			await wait(250);
		}
		return false;
	};
	return {
		evaluate,
		until,
		async go(url) {
			await send("Page.navigate", { url });
			await until(`document.readyState === "complete"`);
			await wait(1500);
		},
		async click(text) {
			const expression = `(() => { const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().includes(${JSON.stringify(text)}) && !b.disabled); if (!b) return false; b.click(); return true; })()`;
			return until(expression);
		},
		has: (needle) => until(`document.body.innerText.includes(${JSON.stringify(needle)})`),
		/** The exact status and error of an API call made by this tab, with its cookies. */
		api: (path, init = {}) =>
			evaluate(
				`fetch(${JSON.stringify(path)}, ${JSON.stringify(init)}).then(async (r) => ({ status: r.status, error: (await r.json().catch(() => ({}))).error ?? null }))`,
			),
		credentials: async () => (await send("WebAuthn.getCredentials", { authenticatorId })).credentials.length,
		async screenshot(file) {
			const { data } = await send("Page.captureScreenshot", { format: "png" });
			writeFileSync(file, Buffer.from(data, "base64"));
		},
		close: () => ws.close(),
	};
}

const json = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const desktop = await tab(Number(args["desktop-port"]), false);
const phone = await tab(Number(args["phone-port"]), true);
let registered = false;
let deleted = false;

try {
	// The front door, and a disposable account from a single-use invite.
	await desktop.go(`${FRONT}/`);
	check("front door is up", (await desktop.api("/health")).status === 200);
	check("front door offers signing in again", await desktop.has("Already have a Pimling?"));
	const registration = await desktop.evaluate(
		`fetch("/auth/register", ${JSON.stringify(json({ username: USER, invite: INVITE }))}).then(async (r) => ({ status: r.status, body: await r.json() }))`,
	);
	if (!check("disposable account registered", registration.status === 201, registration.status === 201 ? "" : `HTTP ${registration.status}: ${registration.body?.error}`)) {
		throw new Error("registration failed");
	}
	registered = true;
	const recoveryCodes = registration.body.recoveryCodes.length;
	const lookup = await desktop.api(`/auth/pimling?name=${USER}`);
	check("lookup finds it", lookup.status === 200);
	const hostile = await Promise.all(["x@evil.com#", "//evil.com", `${USER}.evil.com`].map((name) => desktop.api(`/auth/pimling?name=${encodeURIComponent(name)}`)));
	check("lookup refuses hostile names", hostile.every((r) => r.status === 404), hostile.map((r) => r.status).join(","));

	// Desktop: the first passkey, from the setup link.
	await desktop.go(registration.body.setupUrl);
	await desktop.click("Create passkey");
	check("desktop signed in with its own passkey", await desktop.until(`fetch("/api/sessions").then((r) => r.status === 200)`));
	check("desktop authenticator holds 1 passkey", (await desktop.credentials()) === 1);

	// Phone, before linking.
	await phone.go(`${HOST}/`);
	check("phone isn't signed in", (await phone.api("/api/sessions")).status === 401);
	check("phone's sign-in screen explains adding a device", await phone.has("Signed up on another device?"));

	// Desktop: Add another device. The phone reads the QR code from a screenshot, as its camera would.
	await desktop.go(`${HOST}/settings`);
	await desktop.click("Add another device");
	check("desktop shows a QR code", await desktop.until(`document.querySelector('[role="img"] svg') !== null`));
	await desktop.evaluate(`[...document.querySelectorAll("h2")].find((h) => h.textContent === "Passkeys")?.scrollIntoView({ block: "start" })`);
	await wait(500);
	const qrShot = join(args.artifacts, "live-add-device-qr.png");
	await desktop.screenshot(qrShot);
	const link = execFileSync("python3", ["-c", "import sys, zxingcpp; from PIL import Image; r = zxingcpp.read_barcodes(Image.open(sys.argv[1])); print(r[0].text if r else '')", qrShot])
		.toString()
		.trim();
	check("QR code holds a link to this Pimling, code in the fragment", link.startsWith(`${HOST}/#device=`));

	// Phone: open it, check whose Pimling it is, make its own passkey.
	await phone.go(link);
	check("phone names the Pimling it's adding to", await phone.has("Adding this device to"));
	check("phone took the code out of the address bar", !(await phone.evaluate("location.href")).includes("device="));
	check("no request URL carried the code", (await phone.evaluate(`performance.getEntriesByType("resource").filter((e) => e.name.includes("device=")).length`)) === 0);
	await phone.screenshot(join(args.artifacts, "live-phone-add-this-device.png"));
	await phone.click("Create passkey");
	check("phone signed in with its own new passkey", await phone.until(`fetch("/api/sessions").then((r) => r.status === 200)`));
	check("phone authenticator holds 1 passkey", (await phone.credentials()) === 1);

	// Phone: sign out and back in with that passkey alone.
	await phone.api("/auth/sign-out", { method: "POST" });
	await phone.go(`${HOST}/`);
	check("phone signed out", (await phone.api("/api/sessions")).status === 401);
	await phone.click("Sign in with a passkey");
	check("phone signs in again with its passkey alone", await phone.until(`fetch("/api/sessions").then((r) => r.status === 200)`));

	// Replay: the same link, opened again by someone signed out. The phone signs out for it (a third
	// profile would do too), so the link alone is what's tested; it signs back in afterwards.
	await phone.api("/auth/sign-out", { method: "POST" });
	await phone.go(link);
	await phone.click("Create passkey");
	check("the link can't be used twice", await phone.has("expired or was already used"));
	check("phone still holds just 1 passkey", (await phone.credentials()) === 1);
	await phone.go(`${HOST}/`);
	await phone.click("Sign in with a passkey");
	check("phone signs back in", await phone.until(`fetch("/api/sessions").then((r) => r.status === 200)`));

	// Desktop untouched.
	check("desktop still signed in", (await desktop.api("/api/sessions")).status === 200);
	const passkeys = await desktop.evaluate(`fetch("/auth/passkeys").then((r) => r.json()).then((b) => b.passkeys.length)`);
	check("account has 2 passkeys", passkeys === 2, String(passkeys));
	const left = await desktop.evaluate(`fetch("/auth/recovery-codes").then((r) => r.json()).then((b) => b.left)`);
	check("recovery codes untouched", left === recoveryCodes, `${left} of ${recoveryCodes}`);

	// Deletion, with the phone still signed in.
	const deletion = await desktop.api("/api/account", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: USER }) });
	deleted = deletion.status === 200;
	check("deleted from the desktop", deleted, `HTTP ${deletion.status}`);

	// At once, the phone's session opens nothing: whichever Worker answers, it refuses.
	const now = await phone.api("/api/sessions");
	check("phone's session is refused at once", now.status === 401 || now.status === 403 || now.status === 410, `HTTP ${now.status} ${now.error ?? ""}`.trim());
	const write = await phone.api("/api/memory/log", json({ text: "written after deletion" }));
	check("phone can't write at once", write.status >= 400, `HTTP ${write.status} ${write.error ?? ""}`.trim());

	// Once every Worker's account cache has expired, every request gets 410.
	await wait(Number(args["cache-wait-ms"]));
	const later = await phone.api("/api/sessions");
	check(`phone gets 410 after ${Number(args["cache-wait-ms"]) / 1000} s`, later.status === 410, `HTTP ${later.status} ${later.error ?? ""}`.trim());
	const anonymous = await desktop.evaluate(`fetch(${JSON.stringify(`${HOST}/api/sessions`)}, { credentials: "omit" }).then((r) => r.status)`);
	check("anonymous request gets 410", anonymous === 410, `HTTP ${anonymous}`);
} catch (error) {
	check("ran to the end", false, error instanceof Error ? error.message : String(error));
} finally {
	// Whatever happened, the disposable account doesn't outlive the run.
	if (registered && !deleted) {
		const cleanup = await desktop
			.api("/api/account", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: USER }) })
			.catch((error) => ({ status: 0, error: String(error) }));
		deleted = cleanup.status === 200;
		check("cleanup deleted the disposable account", deleted, `HTTP ${cleanup.status} ${cleanup.error ?? ""}`.trim());
		if (!deleted) console.error(`CLEANUP NEEDED: delete ${USER} with the admin API (DELETE /admin/accounts/${USER}).`);
	}
	desktop.close();
	phone.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(registered && !deleted ? 2 : failed.length > 0 ? 1 : 0);
