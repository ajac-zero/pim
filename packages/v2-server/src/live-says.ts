/**
 * What an app asks of the server over its Live socket (`SayFrame`), answered here, in the process that has the owner's computer on its bus: `watch_file` and `unwatch_file`, so
 * an open file hears of an agent's (or anyone's) change to it as a `file_changed` notice. Each socket's holds on files are counted apart and go with the socket (Live says
 * `closed`), and the computer watches a file for as long as any socket does. Every Gate replica hears every say and keeps its own holds, which add up and end together; notices
 * carry a key, so the apps hear of a change once however many replicas tell them.
 */
import { OwnerId } from "@pim/v2-contracts/identity";
import type { App } from "@pim/v2-app/app";
import type { FileEvent } from "@pim/v2-app/relay";
import type { Pulse } from "@pim/v2-live/server/pulse";
import { filesPath } from "./computer-tools.ts";

type Hold = { ownerId: string; paths: Map<string, number> };

export function serveSays(app: App, pulse: Pick<Pulse, "onSay" | "publishNotice">): () => void {
	const holds = new Map<string, Hold>();
	/** The owners whose files' events this process tells apps of, and how to stop. */
	const listening = new Map<string, () => void>();
	const tell = (ownerId: string, data: { path: string; kind: string; sha256: string | null; size: number | null }, key: string) => void pulse.publishNotice(ownerId, { kind: "file_changed", data, key }).catch(() => undefined);

	const listen = (ownerId: string, computer: { onFileEvent(listener: (event: FileEvent) => void): () => void }) => {
		if (listening.has(ownerId)) return;
		listening.set(ownerId, computer.onFileEvent((event) => {
			if (event.event === "watch_error") {
				for (const hold of holds.values()) if (hold.ownerId === ownerId) hold.paths.delete(event.path);
				return tell(ownerId, { path: event.path, kind: "unwatched", sha256: null, size: null }, `file:${event.path}:unwatched:${Date.now()}`);
			}
			const e = event as FileEvent & { kind?: string; sha256?: string | null; size?: number | null; mtime?: unknown };
			tell(ownerId, { path: e.path, kind: e.kind ?? "modified", sha256: e.sha256 ?? null, size: e.size ?? null }, `file:${e.path}:${e.kind}:${e.sha256}:${String(e.mtime ?? "")}`);
		}));
	};

	const release = async (ownerId: string, paths: Map<string, number>) => {
		const computer = await app.relay.acquire(ownerId, "file_watch").catch(() => null);
		if (!computer) return;
		for (const [path, count] of paths) for (let each = 0; each < count; each++) await computer.unwatch(path).catch(() => undefined);
	};

	const watch = async (ownerId: string, connection: string, requested: unknown) => {
		const path = filesPath(requested);
		if (path === null) return;
		const account = await app.identity.authz.account(ownerId);
		if (!account) return;
		await app.identity.authz.enforce({ kind: "user", ownerId: OwnerId.parse(ownerId), role: account.role, sessionId: "live" }, "computer:use");
		const computer = await app.relay.acquire(ownerId, "file_watch");
		listen(ownerId, computer);
		let state: { exists?: boolean; sha256?: string | null; size?: number | null };
		try {
			state = (await computer.watch(path)) as typeof state;
		} catch (error) {
			// A computer from before watching can't tell of changes: the file opens, and stays as it was read.
			return tell(ownerId, { path, kind: "unwatched", sha256: null, size: null }, `file:${path}:unwatched:${connection}:${Date.now()}`);
		}
		const hold = holds.get(connection);
		if (!hold) {
			// The socket ended while the computer answered: its holds went already, and this one never did.
			await computer.unwatch(path).catch(() => undefined);
			return;
		}
		hold.paths.set(path, (hold.paths.get(path) ?? 0) + 1);
		tell(ownerId, { path, kind: state.exists === false ? "deleted" : "modified", sha256: state.sha256 ?? null, size: state.size ?? null }, `file:${path}:watched:${connection}:${Date.now()}`);
	};

	/** The connections this process has told to watch their files again. */
	const resynced = new Set<string>();

	const unwatch = async (ownerId: string, connection: string, requested: unknown) => {
		const path = filesPath(requested);
		const hold = holds.get(connection);
		const count = path === null ? undefined : hold?.paths.get(path);
		// A socket lets go of a file though this process has heard nothing else of it: this process started after the socket did (a restart, or a replica added), so what the socket watches is not
		// watched here. Its app is told to watch its files again (`file_resync`), once for each socket, and it asks as it did when it opened them.
		if (path !== null && !hold && !resynced.has(connection)) {
			resynced.add(connection);
			if (resynced.size > 5000) resynced.clear();
			void pulse.publishNotice(ownerId, { kind: "file_resync", key: `resync:${connection}` }).catch(() => undefined);
		}
		if (path === null || !hold || count === undefined) return;
		if (count > 1) hold.paths.set(path, count - 1);
		else hold.paths.delete(path);
		await release(ownerId, new Map([[path, 1]]));
	};

	const stop = pulse.onSay((ownerId, said) => {
		void (async () => {
			try {
				const path = (said.data as { path?: unknown } | undefined)?.path;
				if (said.kind === "closed") {
					resynced.delete(said.connection);
					const hold = holds.get(said.connection);
					holds.delete(said.connection);
					if (hold) await release(hold.ownerId, hold.paths);
				} else if (said.kind === "watch_file") {
					// The socket's hold exists before the computer answers, so a socket that ends meanwhile is seen to have.
					if (!holds.has(said.connection)) holds.set(said.connection, { ownerId, paths: new Map() });
					await watch(ownerId, said.connection, path);
				} else if (said.kind === "unwatch_file") await unwatch(ownerId, said.connection, path);
			} catch {
				// No computer, or one that is not the person's to use: the app's file stays as it was read.
			}
		})();
	});
	return () => {
		stop();
		for (const off of listening.values()) off();
		listening.clear();
		holds.clear();
	};
}
