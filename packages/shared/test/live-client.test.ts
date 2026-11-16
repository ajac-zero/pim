import { describe, expect, it, vi } from "vitest";
import {
	LiveClient,
	type LiveSocket,
	type LiveStatus,
	type LiveUpdate,
	SnapshotRefused,
} from "../src/live-client.ts";

const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";
const at = (commit: number, partition = P) => `${partition}:1:${commit}`;

class FakeSocket implements LiveSocket {
	sent: Record<string, unknown>[] = [];
	closedWith: number | undefined;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close(code?: number) {
		this.closedWith = code;
	}
	open() {
		this.onopen?.();
	}
	say(frame: object) {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}
	drop(code = 1006) {
		this.onclose?.({ code });
	}
	/** What was sent that isn't an ack. */
	get subs() {
		return this.sent.filter((frame) => frame.type !== "ack");
	}
}

function setup(
	snapshot: (
		topic: string,
	) => Promise<{ liveCursor: string | null }> = async () => ({
		liveCursor: at(10),
	}),
) {
	const sockets: FakeSocket[] = [];
	const updates: LiveUpdate[] = [];
	const statuses: LiveStatus[] = [];
	const timers: { fn: () => void; ms: number }[] = [];
	const unauthorized = vi.fn();
	const loads: string[] = [];
	const client = new LiveClient({
		openSocket: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		loadSnapshot: (topic) => {
			loads.push(topic);
			return snapshot(topic);
		},
		onUpdate: (update) => updates.push(update),
		onStatus: (status) => statuses.push(status),
		onUnauthorized: unauthorized,
		schedule: (fn, ms) => timers.push({ fn, ms }),
		cancel: () => {},
		random: () => 0.5,
	});
	const ev = (topic: string, cursor: string, extra: object = {}) => ({
		type: "event",
		topic,
		cursor,
		kind: "message",
		data: cursor,
		...extra,
	});
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
	return {
		client,
		sockets,
		updates,
		statuses,
		timers,
		unauthorized,
		loads,
		ev,
		flush,
	};
}

describe("LiveClient", () => {
	it("loads the HTTP snapshot first and subscribes from its cursor, applying each commit once", async () => {
		const t = setup();
		t.client.follow(["chat:a"]);
		// The snapshot is requested before the socket is even open: reads never wait on it.
		expect(t.loads).toEqual(["chat:a"]);
		await t.flush();
		expect(t.client.status).toBe("syncing");
		const s = t.sockets[0]!;
		s.open();
		expect(s.subs).toEqual([
			{ type: "subscribe", topic: "chat:a", cursor: at(10) },
		]);
		expect(t.client.status).toBe("live");
		s.say(t.ev("chat:a", at(11)));
		s.say(t.ev("chat:a", at(11))); // duplicate
		s.say(t.ev("chat:a", at(10))); // replayed
		s.say(t.ev("chat:a", at(12)));
		expect(t.updates.map((update) => update.cursor)).toEqual([at(11), at(12)]);
		await t.flush();
		expect(s.sent.at(-1)).toEqual({ type: "ack", cursor: at(12) });
	});

	it("subscribes from the start when the topic had no events, and tracks partitions apart", async () => {
		const t = setup(async () => ({ liveCursor: null }));
		t.client.follow(["sidebar"]);
		await t.flush();
		const s = t.sockets[0]!;
		s.open();
		expect(s.subs).toEqual([{ type: "subscribe", topic: "sidebar" }]);
		s.say(t.ev("sidebar", at(5, P)));
		s.say(t.ev("sidebar", at(3, Q))); // another partition's commit 3 is new
		s.say(t.ev("sidebar", at(4, P))); // behind P's 5
		expect(t.updates.map((update) => update.cursor)).toEqual([
			at(5, P),
			at(3, Q),
		]);
		expect(t.client.cursor("sidebar")).toBe(at(3, Q));
	});

	it("passes coalesced progress on, saying how many updates it stands for", async () => {
		const t = setup();
		t.client.follow(["chat:a"]);
		await t.flush();
		const s = t.sockets[0]!;
		s.open();
		s.say({
			type: "coalesced_progress",
			topic: "chat:a",
			cursor: at(40),
			skipped: 29,
			data: "latest",
		});
		expect(t.updates).toEqual([
			{
				topic: "chat:a",
				cursor: at(40),
				kind: "progress",
				data: "latest",
				skipped: 29,
			},
		]);
	});

	it("takes a fresh snapshot on snapshot_required, whatever the reason, and subscribes from the new cursor", async () => {
		let cursor = at(10);
		const t = setup(async () => ({ liveCursor: cursor }));
		t.client.follow(["chat:a"]);
		await t.flush();
		const s = t.sockets[0]!;
		s.open();
		s.sent.length = 0;
		cursor = at(500);
		s.say({
			type: "snapshot_required",
			topic: "chat:a",
			reason: "projection_version",
		});
		expect(t.client.cursor("chat:a")).toBeUndefined();
		s.say(t.ev("chat:a", at(11))); // from before the snapshot: not applied
		await t.flush();
		expect(t.loads).toEqual(["chat:a", "chat:a"]);
		expect(s.subs).toEqual([
			{ type: "subscribe", topic: "chat:a", cursor: at(500) },
		]);
		expect(t.updates).toHaveLength(0);
	});

	it("follows only what is on screen: a topic let go is unsubscribed on the same socket, and its frames are ignored", async () => {
		const t = setup();
		t.client.follow(["sidebar", "chat:a"]);
		await t.flush();
		const socket = t.sockets[0]!;
		socket.open();
		t.client.follow(["sidebar", "chat:b"]);
		await t.flush();
		expect(socket.closedWith).toBeUndefined();
		expect(t.sockets).toHaveLength(1);
		expect(socket.subs).toEqual([
			{ type: "subscribe", topic: "sidebar", cursor: at(10) },
			{ type: "subscribe", topic: "chat:a", cursor: at(10) },
			{ type: "unsubscribe", topic: "chat:a" },
			{ type: "subscribe", topic: "chat:b", cursor: at(10) },
		]);
		socket.say(t.ev("chat:a", at(11)));
		expect(t.updates).toHaveLength(0);
		expect(t.loads).toEqual(["sidebar", "chat:a", "chat:b"]);
	});

	it("shows syncing, not offline, while the socket is down, and resumes from each topic's last cursor", async () => {
		const t = setup();
		t.client.follow(["chat:a"]);
		await t.flush();
		const s = t.sockets[0]!;
		s.open();
		s.say(t.ev("chat:a", at(11)));
		s.drop();
		expect(t.client.status).toBe("syncing");
		expect(t.timers).toHaveLength(1);
		t.timers[0]!.fn();
		const next = t.sockets[1]!;
		next.open();
		expect(next.subs).toEqual([
			{ type: "subscribe", topic: "chat:a", cursor: at(11) },
		]);
		expect(t.client.status).toBe("live");
		for (let i = 0; i < 12; i++) {
			t.sockets.at(-1)!.drop();
			t.timers.at(-1)!.fn();
		}
		expect(Math.max(...t.timers.map((timer) => timer.ms))).toBeLessThanOrEqual(
			15_000,
		);
	});

	it("stops everything and reports it on 4003 or a refused snapshot (401, 403, 410)", async () => {
		const a = setup();
		a.client.follow(["chat:a"]);
		await a.flush();
		a.sockets[0]!.open();
		a.sockets[0]!.drop(4003);
		expect(a.unauthorized).toHaveBeenCalledTimes(1);
		expect(a.client.status).toBe("offline");
		expect(a.timers).toHaveLength(0);
		a.client.follow(["chat:b"]);
		expect(a.loads).toEqual(["chat:a"]);
		for (const status of [401, 403, 410]) {
			const b = setup(async () => {
				throw new SnapshotRefused(status);
			});
			b.client.follow(["sidebar"]);
			await b.flush();
			expect(b.unauthorized).toHaveBeenCalledTimes(1);
			expect(b.client.status).toBe("offline");
		}
	});

	it("retries a snapshot that failed for another reason, without giving up the page", async () => {
		let fail = true;
		const t = setup(async () => {
			if (fail) throw new Error("offline");
			return { liveCursor: at(3) };
		});
		t.client.follow(["chat:a"]);
		await t.flush();
		expect(t.unauthorized).not.toHaveBeenCalled();
		fail = false;
		t.timers.at(-1)!.fn();
		await t.flush();
		t.sockets[0]!.open();
		expect(t.sockets[0]!.subs).toEqual([
			{ type: "subscribe", topic: "chat:a", cursor: at(3) },
		]);
	});
});
