/**
 * Settings → Model → "ChatGPT images": `GET /api/chatgpt/images`, `POST /api/chatgpt/images/login` and `/callback`, `DELETE /api/chatgpt/images`. The sign-in is
 * `../codex-images.ts`'s; `generate_image` uses it (`../image-tools.ts`).
 */
import { ok, type Route, route } from "@pim/v2-app/http";
import type { App } from "@pim/v2-app/app";
import { CodexImagesSignIn } from "../codex-images.ts";

type Env = Record<string, string | undefined>;

export function chatgptImagesRoutes(env: Env): Route[] {
	const signIn = new WeakMap<App, CodexImagesSignIn>();
	const of = (app: App) => signIn.get(app) ?? (signIn.set(app, new CodexImagesSignIn(app, env)), signIn.get(app)!);
	return [
		route("GET", "/api/chatgpt/images", async ({ app, principal }) => ok(await of(app).status(await principal()))),
		route("POST", "/api/chatgpt/images/login", async ({ app, principal }) => ok(await of(app).start(await principal()))),
		route("POST", "/api/chatgpt/images/callback", async ({ app, principal, json }) => ok(await of(app).finish(await principal(), (await json()).url))),
		route("DELETE", "/api/chatgpt/images", async ({ app, principal }) => ok(await of(app).logout(await principal()))),
	];
}
