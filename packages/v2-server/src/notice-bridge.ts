/**
 * Tells a person's open apps of what happened in their space at once: a notification, an approval, a changed setting, a task, a visit (`../migrations/0676_notices.sql`).
 * Whichever process wrote the row, PostgreSQL announces it (`pim_notice`); the process that runs this reads the row as its owner and puts it on Pulse, from which every Live
 * replica forwards it to that owner's sockets. A notice is a hint: a lost one costs a reload, and each Gate replica says the same thing, so Live drops the repeats by `key`.
 */
import type { App } from "@pim/v2-app/app";
import type { Pulse } from "@pim/v2-live/server/pulse";
import pg from "pg";
import { webApproval } from "./compat/boot.ts";
import { notificationOf } from "./compat/notifications.ts";

type Heard = { owner: string; kind: string; id: string | null; key: string };

/** What a heard NOTIFY says to the owner's apps, or null when there is nothing to say (the row is gone, or the kind is not one). */
export async function noticeOf(app: App, heard: Heard): Promise<{ kind: string; data?: unknown } | null> {
	switch (heard.kind) {
		case "approval": {
			const row = await app.db.owner(heard.owner, async (tx) => (await tx.query("SELECT * FROM pim_app.approvals WHERE id = $1", [heard.id])).rows[0]);
			return row ? { kind: "approval", data: webApproval(row) } : null;
		}
		case "notification": {
			const row = await notificationOf(app, heard.owner, String(heard.id));
			return row ? { kind: "notification", data: row } : null;
		}
		case "tasks":
			return { kind: "tasks", data: { session: heard.id } };
		case "settings":
		case "visits":
			return { kind: heard.kind };
		default:
			return null;
	}
}

/** Listens for `pim_notice` and tells Pulse. Returns how to stop. */
export function startNoticeBridge(app: App, pulse: Pick<Pulse, "publishNotice">, databaseUrl: string): () => Promise<void> {
	let stopped = false;
	let client: pg.Client | undefined;
	let chain: Promise<void> = Promise.resolve();
	const connect = async () => {
		if (stopped) return;
		const next = new pg.Client({ connectionString: databaseUrl });
		client = next;
		next.on("error", () => undefined);
		next.on("end", () => {
			if (!stopped) setTimeout(() => void connect(), 1_000).unref();
		});
		next.on("notification", (message) => {
			let heard: Heard;
			try {
				heard = JSON.parse(message.payload ?? "") as Heard;
			} catch {
				return;
			}
			// One at a time, so the apps hear of changes in the order they happened.
			chain = chain.then(async () => {
				const notice = await noticeOf(app, heard).catch(() => null);
				if (notice) await pulse.publishNotice(heard.owner, { ...notice, key: heard.key }).catch(() => undefined);
			});
		});
		await next.connect().then(() => next.query("LISTEN pim_notice")).catch(() => next.end().catch(() => undefined));
	};
	void connect();
	return async () => {
		stopped = true;
		await client?.end().catch(() => undefined);
		await chain;
	};
}
