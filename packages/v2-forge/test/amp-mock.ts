// A local Amp: the internal API (POST /api/internal?<method>) the AmpHttpOrbClient speaks, plus attachment downloads, on a real http server.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type MockMessage = { messageId: string; role: "user" | "assistant"; createdAt: number; content: { type: "text"; text: string }[] };

export class MockAmp {
	server!: Server;
	baseUrl = "";
	threads = new Map<string, { messages: MockMessage[]; state: string; queued: string[] }>();
	creates = 0;
	steers: string[] = [];
	auth: string[] = [];
	/** Answer the next calls of a method with this status after doing the work (a lost answer), or before (`before`). */
	fail: Record<string, { status: number; times: number; afterWork: boolean }> = {};
	attachments = new Map<string, { type: string; body: Uint8Array; status?: number }>();
	/** Whether a steer shows up in the transcript at once (the agent took it) or waits queued. */
	deliverAtOnce = true;
	private n = 0;

	async start() {
		this.server = createServer((req, res) => void this.handle(req, res));
		await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
		this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
		return this;
	}
	stop() {
		this.server.closeAllConnections();
		return new Promise<void>((r) => this.server.close(() => r()));
	}
	say(threadId: string, role: "user" | "assistant", text: string) {
		const t = this.threads.get(threadId)!;
		t.messages.push({ messageId: String(t.messages.length + 1), role, createdAt: Date.now(), content: [{ type: "text", text }] });
	}
	deliver(threadId: string) {
		const t = this.threads.get(threadId)!;
		for (const q of t.queued.splice(0)) this.say(threadId, "user", q);
	}

	private async body(req: IncomingMessage) {
		let s = "";
		for await (const c of req) s += c;
		return s;
	}

	private async handle(req: IncomingMessage, res: import("node:http").ServerResponse) {
		const url = new URL(req.url!, this.baseUrl);
		this.auth.push(String(req.headers.authorization));
		if (url.pathname.startsWith("/user-content/attachments/")) {
			const a = this.attachments.get(url.pathname.split("/").pop()!);
			if (!a) return void res.writeHead(404).end();
			res.writeHead(a.status ?? 200, { "content-type": a.type, "content-length": a.body.length }).end(Buffer.from(a.body));
			return;
		}
		const method = url.search.slice(1);
		const { params } = JSON.parse((await this.body(req)) || "{}");
		const fail = this.fail[method];
		const answer = (result: unknown) => {
			if (fail && fail.times > 0 && fail.afterWork) {
				fail.times--;
				return void res.writeHead(fail.status).end("upstream trouble");
			}
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
		};
		if (fail && fail.times > 0 && !fail.afterWork) {
			fail.times--;
			return void res.writeHead(fail.status).end("upstream trouble");
		}
		switch (method) {
			case "resolveProjectByRepositoryURLs":
				return answer({ projectID: "proj-1" });
			case "createRemoteExecutorThread": {
				this.creates++;
				const id = `T-mock${++this.n}`;
				this.threads.set(id, { messages: [], state: "working", queued: [] });
				this.say(id, "user", params.content[0].text);
				return answer({ threadID: id, url: `${this.baseUrl}/threads/${id}` });
			}
			case "getThreadTail": {
				const t = this.threads.get(params.thread);
				if (!t) return void res.writeHead(404).end();
				return answer({ thread: { data: { meta: { lastKnownAgentState: { state: t.state, messageID: t.messages.length, updatedAt: Date.now() } } } }, messages: t.messages.slice(-params.limit) });
			}
			case "sendMessageToThread": {
				const t = this.threads.get(params.threadID)!;
				this.steers.push(params.content[0].text);
				if (this.deliverAtOnce) this.say(params.threadID, "user", params.content[0].text);
				else t.queued.push(params.content[0].text);
				return answer({ latestCursor: String(t.messages.length) });
			}
			case "archiveThread":
				return answer({});
			default:
				return void res.writeHead(400).end();
		}
	}
}

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
export const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4]);
export const HTML = new TextEncoder().encode("<html>not an image</html>");
