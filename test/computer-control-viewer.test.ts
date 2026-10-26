import type { Message } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ControlState } from "../src/computer-control";
import { ControlCoordinator } from "../src/computer-control-runtime";
import { OWNER_HEADER } from "../src/pim";
import { api, connectTestComputer, fakeChrome, OWNER, opens, post, say, TOKEN, toolUse } from "./helpers";
import { faux, type Pim } from "./worker";

/**
 * Live views of the browser (`/browser/live`, "Take over") in a space under
 * control state, over real local WebSockets to the real Worker. The browser
 * is `fakeChrome`, an in-process DevTools peer that records every message
 * reaching it; nothing here runs a browser. A view's revocation is
 * acknowledged only by its socket's own close event, which says nothing more
 * arrives on it. That is no evidence that the browser, or the computer, is quiet.
 */

const stub = () => env.Pim.getByName(OWNER);
const inSpace = <T>(fn: (instance: Pim) => T | Promise<T>) => runInDurableObject(stub(), (instance: Pim) => fn(instance));
const stateOf = (): Promise<ControlState | null> => inSpace((instance) => instance.control.state);
/** The viewer sessions the state records, by status and attempt. */
const viewers = async () => ((await stateOf())?.viewers ?? []).map(({ status, revokeAttempt, epoch }) => ({ status, revokeAttempt, epoch }));

/**
 * A restart, as far as views are concerned: the control state read anew from
 * storage, and a browser that forgot who was watching, while the views'
 * sockets stay open as hibernated ones do. (Evicting the space in a test
 * waits for the Worker that proxies each view's socket to let go of it.)
 */
const restart = () =>
	inSpace(async (instance) => {
		for (const connection of instance.getConnections("browser")) await instance.browser.unwatch(connection.id);
		const storage = { read: () => instance.store.meta("computer_control"), write: (value: string) => instance.store.setMeta("computer_control", value) };
		Object.defineProperty(instance, "control", { configurable: true, value: new ControlCoordinator(instance.name, storage) });
	});

const chrome = fakeChrome();
/** The DevTools messages a person's input becomes. */
const INPUT = ["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Page.navigate", "Page.reload", "Page.navigateToHistoryEntry"];
const inputSince = (mark: number) => chrome.packets.slice(mark).filter((packet) => INPUT.includes(packet.method));
const UNAVAILABLE = { type: "error", message: expect.stringContaining("Taking over the browser isn't available in this space") };
const REFUSED = 4005;

/** A tab taking the browser over, as the app opens one, named `_pk` as the client chooses: it hears the page, and its mouse and keyboard. */
async function liveView(name?: string, token = TOKEN) {
	const response = await opens(`/browser/live${name ? `?_pk=${name}` : ""}`, token);
	const socket = response.webSocket;
	if (!socket) throw new Error(`no socket: ${response.status}`);
	const heard: { type: string; [key: string]: unknown }[] = [];
	let closedWith: number | null = null;
	const closed = new Promise<CloseEvent>((resolve) =>
		socket.addEventListener("close", (event) => {
			closedWith = event.code;
			resolve(event);
		}),
	);
	socket.addEventListener("message", (event) => heard.push(JSON.parse(event.data as string)));
	socket.accept();
	return {
		socket,
		heard,
		closed,
		closedWith: () => closedWith,
		/** A click, a key, pasted text and an address, as the app sends them. */
		use: () => {
			socket.send(JSON.stringify({ type: "mouse", event: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 }));
			socket.send(JSON.stringify({ type: "key", event: "keyDown", key: "a", code: "KeyA", text: "a" }));
			socket.send(JSON.stringify({ type: "text", text: "secret" }));
			socket.send(JSON.stringify({ type: "navigate", url: "https://example.com/" }));
		},
	};
}
type View = Awaited<ReturnType<typeof liveView>>;
const watching = (view: View) => vi.waitFor(() => expect(view.heard).toContainEqual(expect.objectContaining({ type: "page" })));

function lastToolResult(messages: readonly Message[]) {
	const result = messages.findLast((message) => message.role === "toolResult");
	if (!result || result.role !== "toolResult") throw new Error("no tool result");
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
/** The agent uses a browser tool: in a space under control state, a request the state must admit. */
async function agentUses(name: string, args: Record<string, string> = {}) {
	let result = "";
	faux.setResponses([
		toolUse(name, args),
		(context) => {
			result = lastToolResult(context.messages);
			return toolUse("send_to_user", { message: "Ok." });
		},
	]);
	await say(`Use ${name}`);
	return result;
}

beforeAll(async () => {
	const { body } = await post<{ token: string }>("/computer");
	const ok = { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false };
	await connectTestComputer(body.token, `/tmp/computer-viewer-${crypto.randomUUID()}`, async () => ok, chrome.host);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("taking the browser over in a space that has not opted in", () => {
	it("works as before: the view hears the page and the person's input reaches the browser, with nothing recorded", async () => {
		// An agent opened the page the person takes over.
		expect(await agentUses("browser_open", { url: "https://example.com/" })).toContain("# Fixture");
		const view = await liveView();
		await watching(view);
		const mark = chrome.packets.length;
		view.use();
		await vi.waitFor(() => expect(inputSince(mark).map((packet) => packet.method)).toEqual(["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Page.navigate"]));
		expect((await api("/browser")).body).toMatchObject({ available: true, takeOver: true });
		expect(await inSpace((instance) => [instance.control.enabled, instance.control.state])).toEqual([false, null]);
		// Closed by the person, its pictures stop.
		view.socket.close();
		await vi.waitFor(() => expect(chrome.sent("Page.stopScreencast", mark)).toHaveLength(1));
	});
});

describe("a space that opts in while people take the browser over", () => {
	/** Views admitted before the space opted in, by the name their client gave them. */
	const views: Record<string, View> = {};
	let stuckViewer = "";

	it("refuses input from a view admitted before, and from one that finishes opening after, ending each once recorded", async () => {
		// One view is still opening: its pictures haven't started when the space opts in.
		chrome.hold.add("Page.startScreencast");
		const before = chrome.packets.length;
		const opening = liveView("opening");
		await vi.waitFor(() => expect(chrome.sent("Page.startScreencast", before)).toHaveLength(1));
		for (const name of ["early", "quiet", "failing", "stuck", "spare"]) {
			views[name] = await liveView(name);
			await watching(views[name]);
		}

		await inSpace((instance) => instance.control.enable());
		const mark = chrome.packets.length;

		// One sends what the person does: none of it reaches the browser, and it is ended.
		views.early!.use();
		expect((await views.early!.closed).code).toBe(REFUSED);
		expect(views.early!.heard).toContainEqual(UNAVAILABLE);

		// The one opening finishes after: it is ended too, before anything it sends is read.
		chrome.hold.delete("Page.startScreencast");
		const held = chrome.sent("Page.startScreencast", before)[0]!;
		chrome.inject({ id: held.id, sessionId: held.sessionId, result: {} });
		const late = await opening;
		expect((await late.closed).code).toBe(REFUSED);
		expect(late.heard).toContainEqual(UNAVAILABLE);

		// Each is a viewer of the epoch it was recorded in, acknowledged revoked by its socket's close; the others aren't recorded yet.
		await vi.waitFor(async () => expect(await viewers()).toEqual([{ status: "revoked", revokeAttempt: 1, epoch: 0 }, { status: "revoked", revokeAttempt: 1, epoch: 0 }]));
		// Recorded under the server's own names, not the ones their clients chose.
		expect((await stateOf())!.viewers.map((viewer) => viewer.sessionId)).not.toContain("early");
		expect(inputSince(mark)).toEqual([]);
		expect((await api("/browser")).body).toMatchObject({ takeOver: false });
	});

	it("keeps refusing a view it can't record when storage fails, and agents too, until a restart reads what was stored", async () => {
		await inSpace((instance) => {
			const setMeta = instance.store.setMeta.bind(instance.store);
			vi.spyOn(instance.store, "setMeta").mockImplementation((key, value) => {
				if (key === "computer_control") throw new Error("disk full");
				setMeta(key, value);
			});
		});
		const recorded = await viewers();
		const mark = chrome.packets.length;
		// Its input is refused, though recording it fails; that latches the state blocked, so agents are refused too.
		views.spare!.use();
		await vi.waitFor(() => expect(views.spare!.heard.filter((message) => message.type === "error")).toEqual(Array(4).fill(UNAVAILABLE)));
		expect(await agentUses("browser_read")).toContain("could not be stored");
		vi.restoreAllMocks();
		// Storage is back, but what is remembered can't be trusted: everything stays refused, and the view isn't closed unrecorded.
		expect(await agentUses("browser_read")).toContain("could not be stored");
		views.spare!.use();
		await vi.waitFor(() => expect(views.spare!.heard.filter((message) => message.type === "error")).toHaveLength(8));
		expect(views.spare!.closedWith()).toBeNull();
		expect(inputSince(mark)).toEqual([]);

		// A restart reads what was stored, where that view isn't recorded yet. Its socket survives it.
		await restart();
		expect(await viewers()).toEqual(recorded);
	});

	it("refuses agents while a view it can't record is open: the state takes no viewer while the agent holds the lease", async () => {
		expect(await inSpace((instance) => instance.control.apply({ type: "resume", leaseId: "lease-1" }))).toEqual({ ok: true });
		const mark = chrome.packets.length;
		expect(await agentUses("browser_read")).toContain("a live view of the browser can't be recorded (wrong_owner)");
		expect(chrome.packets.length).toBe(mark);
		expect(Object.values(views).filter((view) => view.closedWith() === null)).toHaveLength(4);
		expect((await stateOf())!.viewers).toHaveLength(2);
		// The person takes control in the application's books, which records nothing about the views and stops nothing.
		expect(await inSpace((instance) => instance.control.apply({ type: "takeover" }))).toEqual({ ok: true });
	});

	it("ends every other view before an agent's request, each stored as revoking before its socket is closed", async () => {
		const stored: { view: string; status?: string }[] = [];
		await inSpace((instance) => {
			const close = WebSocket.prototype.close;
			vi.spyOn(WebSocket.prototype, "close").mockImplementation(function (this: WebSocket & { id: string; state: { viewer?: string } }, code, reason) {
				if (code !== REFUSED) return close.call(this, code, reason);
				const document = JSON.parse(instance.store.meta("computer_control")!) as { state: ControlState };
				stored.push({ view: this.id, status: document.state.viewers.find((viewer) => viewer.sessionId === this.state.viewer)?.status });
				// One close throws, and one never completes.
				if (this.id === "failing") throw new Error("close failed");
				if (this.id === "stuck") return;
				return close.call(this, code, reason);
			});
		});
		const mark = chrome.packets.length;
		// Refused anyway: the person has control.
		expect(await agentUses("browser_read")).toContain("nothing was sent to it");
		vi.restoreAllMocks();
		expect(stored.sort((a, b) => a.view.localeCompare(b.view))).toEqual(["failing", "quiet", "spare", "stuck"].map((view) => ({ view, status: "revoking" })));
		expect((await views.quiet!.closed).code).toBe(REFUSED);
		expect((await views.spare!.closed).code).toBe(REFUSED);
		const viewerOf = (name: string) => inSpace((instance) => [...instance.getConnections<{ viewer: string }>("browser")].find((connection) => connection.id === name)!.state!.viewer);
		const failing = await viewerOf("failing");
		const stuck = await viewerOf("stuck");
		await vi.waitFor(async () => {
			const recorded = (await stateOf())!.viewers;
			expect(recorded.map(({ status }) => status).sort()).toEqual(["revoke_failed", "revoked", "revoked", "revoked", "revoked", "revoking"]);
			expect(recorded.find((viewer) => viewer.sessionId === failing)).toMatchObject({ status: "revoke_failed", revokeAttempt: 1, epoch: 2 });
			expect(recorded.find((viewer) => viewer.sessionId === stuck)).toMatchObject({ status: "revoking", revokeAttempt: 1, epoch: 2 });
		});
		expect([views.failing!.closedWith(), views.stuck!.closedWith()]).toEqual([null, null]);

		// The one whose close failed is still open, and still refused; what it sends next ends it, on a new attempt.
		views.failing!.use();
		expect((await views.failing!.closed).code).toBe(REFUSED);
		await vi.waitFor(async () => expect((await stateOf())!.viewers.find((viewer) => viewer.sessionId === failing)).toMatchObject({ status: "revoked", revokeAttempt: 2 }));
		expect(inputSince(mark)).toEqual([]);
		stuckViewer = stuck;
	});

	it("refuses a new view, and one reconnecting under an earlier view's name, watching and recording nothing", async () => {
		const recorded = await viewers();
		const mark = chrome.packets.length;
		for (const name of [undefined, "early"]) {
			const view = await liveView(name);
			expect((await view.closed).code).toBe(REFUSED);
			expect(view.heard).toEqual([UNAVAILABLE]);
		}
		expect(chrome.packets.slice(mark)).toEqual([]);
		expect(await viewers()).toEqual(recorded);
	});

	it("keeps agents out until the last view's close is acknowledged, from any epoch, and a restart doesn't count an attempt cut short", async () => {
		const stuck = () => stateOf().then((state) => state!.viewers.find((viewer) => viewer.sessionId === stuckViewer));
		expect(await inSpace((instance) => instance.control.apply({ type: "resume", leaseId: "lease-2" }))).toEqual({ ok: true });
		const mark = chrome.packets.length;
		// The view that never closed was recorded in epoch 2; the agent holds epoch 3's lease, and is still kept out.
		expect(await agentUses("browser_read")).toContain("nothing was sent to it");
		expect(chrome.packets.length).toBe(mark);

		// The space restarts; the view's socket survives it, as hibernated ones do. The attempt in progress is restored as failed.
		await restart();
		const restarted = chrome.packets.length;
		expect(await stuck()).toMatchObject({ status: "revoke_failed", revokeAttempt: 1, epoch: 2 });
		// What the view sends wakes the space: it doesn't watch again, nothing it sends reaches the browser, and it is ended on a new attempt.
		views.stuck!.use();
		expect((await views.stuck!.closed).code).toBe(REFUSED);
		expect(views.stuck!.heard).toContainEqual(UNAVAILABLE);
		await vi.waitFor(async () => expect(await stuck()).toMatchObject({ status: "revoked", revokeAttempt: 2 }));
		expect(chrome.packets.slice(restarted)).toEqual([]);

		// Every view acknowledged, the agent's request is admitted.
		expect(await agentUses("browser_read")).toContain("# Fixture");
		expect((await stateOf())!.requests.at(-1)).toMatchObject({ status: "completed", epoch: 3 });
	});
});

/** Another person, with a space of their own and an API token to it. */
async function person(username: string) {
	const directory = env.Directory.getByName("directory");
	const registered = await directory.register({ username, ip: "192.0.2.9", claim: { window: false }, policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 } });
	if (!registered.ok) throw new Error(registered.error);
	const owner = registered.account.ownerId;
	await directory.activate(owner);
	await (await getAgentByName(env.Pim, owner)).provision({ ownerId: owner, username });
	return { owner, token: (await env.Auth.getByName(owner).createToken(owner, "tests", Date.now())).token };
}

describe("who can take the browser over", () => {
	it("is still only the space's own signed-in person: no token, another person's, or a request routed to the wrong space opens nothing here", async () => {
		const recorded = await stateOf();
		const mark = chrome.packets.length;
		expect((await opens("/browser/live", "pim_nobody_secret")).status).toBe(401);
		// Another person's token opens their own space, which has no browser.
		const other = await person("viewer-other");
		const theirs = await liveView(undefined, other.token);
		expect((await theirs.closed).code).toBe(4004);
		// A request that reaches this space naming another owner is refused before any socket.
		const misrouted = await stub().fetch(new Request("https://pim.test/browser/live", { headers: { Upgrade: "websocket", [OWNER_HEADER]: other.owner } }));
		expect([misrouted.status, misrouted.webSocket]).toEqual([421, null]);
		expect(chrome.packets.length).toBe(mark);
		expect(await stateOf()).toEqual(recorded);
	});
});
