import type { Account } from "../../directory";
import type { ApiExtension } from "../../gateway";
import { dispatch, readJson, type Route } from "../../http";
import { cliHarness } from "../harness";
import { validLoginCode } from "../harness/login";
import { codingScheduler } from "../scheduler-do";
import { CODING_VAULT_PATH, type HarnessLoginStatus, isHarness } from "./harnesses";
import type { VaultStatus } from "./store";
import { codingVault } from "./vault";

/**
 * The coding vault's API, `/api/coding/vault`, for the signed-in person's
 * own logins: the gateway (../../gateway.ts) has checked who they are, and
 * every route reaches only their own space. It says whether each harness is
 * connected, when it changed and how big it is, and disconnects one; no
 * route returns what a login holds, and a login is only ever made by the
 * CLI's own sign-in inside the person's workspace, which `/:harness/login`
 * starts and relays (../harness/login.ts): the sign-in URL to the person,
 * and the code they paste back to the CLI.
 */
export function codingVaultApi(env: Env, account: Account, request: Request): ApiExtension {
	return async (path) => {
		if (path !== CODING_VAULT_PATH && !path.startsWith(`${CODING_VAULT_PATH}/`)) return undefined;
		if (account.role === "guest") return Response.json({ error: "A guest's account has no coding harness logins.", code: "forbidden" }, { status: 403 });
		return dispatch(vaultRoutes(env, account.ownerId), request, path);
	};
}

/** Only what the API may say of an entry. */
const publicStatus = ({ harness, connected, updatedAt, byteLength }: VaultStatus): HarnessLoginStatus => ({ harness, connected, updatedAt, byteLength });

const route = (method: string, pattern: string, handler: Route[2]): Route => [
	method,
	`${CODING_VAULT_PATH}${pattern}`,
	async (params, request, url) => {
		try {
			return await handler(params, request, url);
		} catch (error) {
			// The error's name only: a vault error's message never holds a login, but nothing here relies on that.
			console.error(JSON.stringify({ event: "pim.coding.vault_api_failed", error: error instanceof Error ? error.name : "unknown" }));
			return Response.json({ error: "The coding vault failed" }, { status: 500 });
		}
	},
];

function vaultRoutes(env: Env, userId: string): Route[] {
	const vault = codingVault(env);
	const harnessOf = (given: string | undefined) => (isHarness(given) ? given : null);
	const unknown = () => Response.json({ error: "No such coding harness", code: "not_found" }, { status: 404 });
	/** A harness whose CLI has a sign-in Pim relays. */
	const loginOf = (given: string | undefined) => {
		const known = harnessOf(given);
		return known && cliHarness(known)?.login ? known : null;
	};
	const noLogin = () => Response.json({ error: "No sign-in for that harness", code: "not_found" }, { status: 404 });
	return [
		route("GET", "", async () => ({ harnesses: (await vault.status(userId)).map(publicStatus) })),
		route("GET", "/:harness", async ({ harness }) => {
			const known = harnessOf(harness);
			if (!known) return unknown();
			return publicStatus((await vault.status(userId)).find((status) => status.harness === known)!);
		}),
		route("GET", "/:harness/login", async ({ harness }) => {
			const known = loginOf(harness);
			if (!known) return noLogin();
			return codingScheduler(env, userId).harnessLoginStatus(known);
		}),
		route("POST", "/:harness/login", async ({ harness }) => {
			const known = loginOf(harness);
			if (!known) return noLogin();
			return codingScheduler(env, userId).harnessLoginStart(userId, known);
		}),
		route("POST", "/:harness/login/code", async ({ harness }, request) => {
			const known = loginOf(harness);
			if (!known) return noLogin();
			const body = (await readJson(request).catch(() => null)) as { code?: unknown } | null;
			// The code is a credential: it is handed on and never logged, echoed or kept.
			if (!validLoginCode(body?.code)) return Response.json({ error: "Paste the code the sign-in page shows", code: "invalid" }, { status: 400 });
			return codingScheduler(env, userId).harnessLoginCode(known, body.code);
		}),
		route("DELETE", "/:harness/login", async ({ harness }) => {
			const known = loginOf(harness);
			if (!known) return noLogin();
			return codingScheduler(env, userId).harnessLoginCancel(known);
		}),
		route("DELETE", "/:harness", async ({ harness }) => {
			const known = harnessOf(harness);
			if (!known) return unknown();
			const status = publicStatus(await vault.delete(userId, known));
			console.info(JSON.stringify({ event: "pim.coding.vault_disconnected", user: userId, harness: known }));
			return status;
		}),
	];
}
