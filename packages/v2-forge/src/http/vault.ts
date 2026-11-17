// `/api/coding/vault/*` and `/api/coding/gitea/*`: a person connects their harness logins and keys, and the admin connects the deployment's Gitea. Nothing here ever returns key material.
import { ApiKeyError, type ForgeVault } from "../vault";
import { CapabilityUnavailableError, ForgeError } from "../errors";
import { type GiteaConnection } from "../gitea";
import { type Authenticate, type Handler, guarded, json, match, notGuest, readJson } from "./common";
import { HARNESSES, isApiKeyHarness, isHarness, isLoginHarness } from "@pim/shared/harnesses";
import { validLoginCode } from "@pim/coding/harness/login";
import type { VaultStatus } from "@pim/coding/vault/store";

/** The CLI's own sign-in, run in a short-lived workspace (`@pim/coding/harness/login`). Not part of Forge's core: a deployment wires it, and without it the routes answer 503. */
export interface LoginFlows {
	start(ownerId: string, harness: string): Promise<unknown>;
	status(ownerId: string, harness: string): Promise<unknown>;
	cancel(ownerId: string, harness: string): Promise<unknown>;
	submitCode(ownerId: string, harness: string, code: string): Promise<unknown>;
}

/** Only what the API may say of an entry: not its version, and not even an API key's length. */
const publicStatus = ({ harness, connected, updatedAt, byteLength }: VaultStatus) => ({ harness, connected, updatedAt, byteLength: isApiKeyHarness(harness) ? null : byteLength });

/** `vault` may be a function of the owner, for a process that reads under row-level security (the vault's table is owner-scoped). */
export function codingVault(d: {
	vault: ForgeVault | ((ownerId: string) => ForgeVault);
	authenticate: Authenticate;
	login?: LoginFlows;
	/** After a harness is connected (a key saved or a sign-in finished): the person's threads that waited for it go on. */
	connected?: (ownerId: string, harness: string) => Promise<void>;
}): Handler {
	return async (req) => {
		const path = new URL(req.url).pathname;
		if (!path.startsWith("/api/coding/vault")) return null;
		return guarded(async () => {
			const { actor } = notGuest(await d.authenticate(req));
			const vault = typeof d.vault === "function" ? d.vault(actor.ownerId) : d.vault;
			const status = async (harness: string) => publicStatus((await vault.status(actor.ownerId)).find((s) => s.harness === harness)!);
			if (match("/api/coding/vault", path) && req.method === "GET") return json(200, { harnesses: (await vault.status(actor.ownerId)).map(publicStatus), supported: HARNESSES });
			const m = match("/api/coding/vault/:harness/:what/:more", path) ?? match("/api/coding/vault/:harness/:what", path) ?? match("/api/coding/vault/:harness", path);
			if (!m) throw new ForgeError("not_found", "No such vault route");
			const harness = String(m.harness);
			if (!isHarness(harness)) throw new ForgeError("not_found", `No coding harness ${harness}`);
			const key = `${req.method} ${m.what ?? ""}${m.more ? `/${m.more}` : ""}`.trim();
			const flows = () => {
				if (!isLoginHarness(harness)) throw new ForgeError("not_found", "No sign-in for that harness");
				if (!d.login) throw new CapabilityUnavailableError("coding:login", "this deployment has no harness sign-in workspace");
				return d.login;
			};
			switch (key) {
				case "GET":
					return json(200, await status(harness));
				case "PUT api-key": {
					if (!isApiKeyHarness(harness)) throw new ForgeError("not_found", `${harness} signs in with a login, not a key`);
					try {
						const saved = publicStatus(await vault.saveApiKey(actor.ownerId, harness, (await readJson(req, 4096)).apiKey));
						await d.connected?.(actor.ownerId, harness);
						return json(200, saved);
					} catch (e) {
						if (e instanceof ApiKeyError) throw new ForgeError("invalid", e.message);
						throw e;
					}
				}
				case "DELETE": {
					// A running sign-in goes with it.
					if (d.login && isLoginHarness(harness)) await d.login.cancel(actor.ownerId, harness).catch(() => {});
					await vault.delete(actor.ownerId, harness);
					console.info(JSON.stringify({ event: "pim.coding.vault_disconnected", user: actor.ownerId, harness }));
					return json(200, await status(harness));
				}
				case "DELETE login":
					return json(200, await flows().cancel(actor.ownerId, harness));
				case "POST login":
					return json(200, await flows().start(actor.ownerId, harness));
				case "GET login":
					return json(200, await flows().status(actor.ownerId, harness));
				case "POST login/code": {
					const code = (await readJson(req, 4096)).code;
					// The code is a credential: it is handed on and never logged, echoed or kept.
					if (!validLoginCode(code)) throw new ForgeError("invalid", "Paste the code the sign-in page shows");
					return json(200, await flows().submitCode(actor.ownerId, harness, code));
				}
			}
			throw new ForgeError("not_found", "No such vault route");
		});
	};
}

/** `gitea` is null where the deployment has no Gitea OAuth application: the status then says so, as the web app expects, and nothing else is served. */
export function codingGitea(d: { gitea: GiteaConnection | null; authenticate: Authenticate }): Handler {
	const off = { configured: false, connected: false, login: null, needsReconnect: false };
	return async (req) => {
		const url = new URL(req.url);
		if (!url.pathname.startsWith("/api/coding/gitea/")) return null;
		return guarded(async () => {
			const caller = notGuest(await d.authenticate(req));
			const admin = () => {
				if (caller.actor.role !== "admin" || caller.via !== "session") throw new ForgeError("forbidden", "Only the Pim owner connects Gitea");
			};
			const route = `${req.method} ${url.pathname.slice("/api/coding/gitea/".length)}`;
			const status = async () => {
				const s = await d.gitea!.status();
				return { configured: true, connected: s.connected, login: s.login, needsReconnect: s.needsReconnect };
			};
			if (route === "GET status") return json(200, d.gitea ? await status() : off);
			if (!d.gitea) throw new ForgeError("not_found", "Gitea isn't configured on this deployment");
			// The browser lands on the coding settings, which say how it went.
			const back = (result: string) => new Response(null, { status: 302, headers: { location: `/?dialog=settings&tab=coding&gitea=${result}`, "cache-control": "no-store" } });
			switch (route) {
				case "GET authorize":
					admin();
					return new Response(null, { status: 302, headers: { location: await d.gitea.authorizeUrl(caller.actor.ownerId), "cache-control": "no-store" } });
				case "POST connect":
					admin();
					return json(200, { url: await d.gitea.authorizeUrl(caller.actor.ownerId) });
				case "GET callback": {
					admin();
					if (url.searchParams.has("error")) return back("denied");
					try {
						const { login } = await d.gitea.complete(caller.actor.ownerId, url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "");
						console.info(JSON.stringify({ event: "pim.gitea.connected", user: caller.actor.ownerId, login }));
					} catch (e) {
						console.warn(JSON.stringify({ event: "pim.gitea.connect_failed", user: caller.actor.ownerId, error: String(e).slice(0, 300) }));
						return back("failed");
					}
					return back("connected");
				}
				case "POST disconnect":
				case "DELETE connection":
				case "DELETE disconnect":
					admin();
					await d.gitea.disconnect();
					return json(200, await status());
			}
			throw new ForgeError("not_found", "No such Gitea route");
		});
	};
}
