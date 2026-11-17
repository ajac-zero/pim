import { ok, type Route, route } from "../http.ts";

/** Sign in with ChatGPT: the status, the start, the finish with the address the browser landed on, and the disconnect. */
export const chatgptRoutes: Route[] = [
	route("GET", "/api/chatgpt", async ({ app, principal }) => ok(await app.chatgpt.status(await principal()))),
	route("POST", "/api/chatgpt/login", async ({ app, principal }) => ok(await app.chatgpt.startLogin(await principal()))),
	route("POST", "/api/chatgpt/callback", async ({ app, principal, json }) => ok(await app.chatgpt.finishLogin(await principal(), (await json()).url))),
	route("DELETE", "/api/chatgpt", async ({ app, principal }) => ok(await app.chatgpt.logout(await principal()))),
];
