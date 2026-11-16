// `/api/coding/vault/*` and `/api/coding/gitea/*`: a person connects their harness logins and keys, and the admin connects the deployment's Gitea. Nothing here ever returns key material.
import { ApiKeyError, type ForgeVault } from "../vault";
import { CapabilityUnavailableError, ForgeError } from "../errors";
import { type GiteaConnection } from "../gitea";
import { type Authenticate, type Handler, guarded, json, match, notGuest, readJson } from "./common";
import { HARNESSES, isApiKeyHarness, isHarness, isLoginHarness } from "@pim/shared/harnesses";

/** The CLI's own sign-in, run in a short-lived workspace (`@pim/coding/harness/login`). Not part of Forge's core: a deployment wires it, and without it the routes answer 503. */
export interface LoginFlows {
	start(ownerId: string, harness: string): Promise<unknown>;
	status(ownerId: string, harness: string): Promise<unknown>;
	cancel(ownerId: string, harness: string): Promise<unknown>;
	submitCode(ownerId: string, code: string): Promise<unknown>;
}

export function codingVault(d: { vault: ForgeVault; authenticate: Authenticate; login?: LoginFlows }): Handler {
	return async (req) => {
		const path = new URL(req.url).pathname;
		if (!path.startsWith("/api/coding/vault")) return null;
		return guarded(async () => {
			const { actor } = notGuest(await d.authenticate(req));
			let m = match("/api/coding/vault", path);
			if (m && req.method === "GET") return json(200, { harnesses: await d.vault.status(actor.ownerId), supported: HARNESSES });
			m = match("/api/coding/vault/:harness/:what", path) ?? match("/api/coding/vault/:harness/:what/:more", path) ?? match("/api/coding/vault/:harness", path);
			if (!m) throw new ForgeError("not_found", "No such vault route");
			const harness = String(m.harness);
			if (!isHarness(harness)) throw new ForgeError("not_found", `No coding harness ${harness}`);
			const key = `${req.method} ${m.what ?? ""}${m.more ? `/${m.more}` : ""}`;
			const flows = () => {
				if (!d.login) throw new CapabilityUnavailableError("coding:login", "this deployment has no harness sign-in workspace");
				return d.login;
			};
			switch (key) {
				case "PUT api-key": {
					if (!isApiKeyHarness(harness)) throw new ForgeError("not_found", `${harness} signs in with a login, not a key`);
					try {
						return json(200, await d.vault.saveApiKey(actor.ownerId, harness, (await readJson(req, 4096)).apiKey));
					} catch (e) {
						if (e instanceof ApiKeyError) throw new ForgeError("invalid", e.message);
						throw e;
					}
				}
				case "DELETE login":
				case "DELETE ":
					// A running sign-in goes with it.
					if (d.login && isLoginHarness(harness)) await d.login.cancel(actor.ownerId, harness).catch(() => {});
					return json(200, await d.vault.delete(actor.ownerId, harness));
				case "POST login":
					return json(200, await flows().start(actor.ownerId, harness));
				case "GET login":
					return json(200, await flows().status(actor.ownerId, harness));
				case "POST login/code":
					return json(200, await flows().submitCode(actor.ownerId, String((await readJson(req, 4096)).code ?? "")));
			}
			throw new ForgeError("not_found", "No such vault route");
		});
	};
}

export function codingGitea(d: { gitea: GiteaConnection; authenticate: Authenticate }): Handler {
	return async (req) => {
		const url = new URL(req.url);
		if (!url.pathname.startsWith("/api/coding/gitea/")) return null;
		return guarded(async () => {
			const caller = notGuest(await d.authenticate(req));
			const admin = () => {
				if (caller.actor.role !== "admin" || caller.via !== "session") throw new ForgeError("forbidden", "Only the Pim owner connects Gitea");
			};
			switch (`${req.method} ${url.pathname.slice("/api/coding/gitea/".length)}`) {
				case "GET status":
					return json(200, await d.gitea.status());
				case "POST connect":
					admin();
					return json(200, { url: await d.gitea.authorizeUrl(caller.actor.ownerId) });
				case "GET callback": {
					admin();
					const code = url.searchParams.get("code");
					const state = url.searchParams.get("state");
					if (!code || !state) throw new ForgeError("invalid", "The sign-in came back without a code");
					return json(200, { connected: true, ...(await d.gitea.complete(caller.actor.ownerId, state, code)) });
				}
				case "POST disconnect":
				case "DELETE disconnect":
					admin();
					await d.gitea.disconnect();
					return json(200, await d.gitea.status());
			}
			throw new ForgeError("not_found", "No such Gitea route");
		});
	};
}
