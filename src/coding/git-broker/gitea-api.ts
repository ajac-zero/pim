import type { Account } from "../../directory";
import { deploymentSettings } from "../../deployment";
import type { ApiExtension } from "../../gateway";
import { dispatch, HttpError, type Route } from "../../http";
import { deploymentGitea } from "./routes";

/**
 * The Gitea connection's API, `/api/coding/gitea`, for people who are signed
 * in to Pim (the gateway, ../../gateway.ts, has checked who). Pim connects
 * to Gitea as one account for the whole deployment, so only the admin
 * starts the sign-in (`/authorize`, which sends the browser to Gitea), ends
 * it (`/callback`, where Gitea sends the browser back) and disconnects
 * (`DELETE /connection`); any member may read `/status`, which says whether
 * Gitea is configured and connected, as which Gitea login, and whether it
 * needs a new sign-in, and never a token or the client's secret.
 */

export const GITEA_API_PATH = "/coding/gitea";

export function giteaApi(env: Env, account: Account, request: Request): ApiExtension {
	return async (path) => {
		if (!path.startsWith(`${GITEA_API_PATH}/`)) return undefined;
		if (account.role === "guest") return Response.json({ error: "A guest's account has no coding threads." }, { status: 403 });
		return dispatch(giteaRoutes(env, account), request, path);
	};
}

function giteaRoutes(env: Env, account: Account): Route[] {
	const gitea = () => deploymentGitea(env).connection;
	const admin = () => {
		if (account.role !== "admin") throw new HttpError(403, "Only the Pim owner connects Gitea");
	};
	const redirectUri = () => {
		const origin = deploymentSettings(env).publicUrl;
		if (!origin) throw new HttpError(409, "PIM_PUBLIC_URL isn't set, so Gitea can't send the browser back to Pim");
		return `${origin}/api${GITEA_API_PATH}/callback`;
	};
	return [
		["GET", `${GITEA_API_PATH}/status`, async () => gitea().status()],
		[
			"GET",
			`${GITEA_API_PATH}/authorize`,
			async () => {
				admin();
				return new Response(null, { status: 302, headers: { Location: await gitea().authorizeUrl(account.ownerId, redirectUri()), "Cache-Control": "no-store" } });
			},
		],
		[
			"GET",
			`${GITEA_API_PATH}/callback`,
			async (_params, _request, url) => {
				admin();
				// Gitea says why when the person said no.
				if (url.searchParams.has("error")) throw new HttpError(400, "Gitea didn't let Pim in");
				const login = await gitea().complete(account.ownerId, url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "", redirectUri());
				console.info(JSON.stringify({ event: "pim.gitea.connected", user: account.ownerId, login }));
				return new Response(null, { status: 302, headers: { Location: "/?gitea=connected", "Cache-Control": "no-store" } });
			},
		],
		[
			"DELETE",
			`${GITEA_API_PATH}/connection`,
			async () => {
				admin();
				await gitea().disconnect();
				console.info(JSON.stringify({ event: "pim.gitea.disconnected", user: account.ownerId }));
				return gitea().status();
			},
		],
	];
}
