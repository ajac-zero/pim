/**
 * The coding threads API in the shapes the web app reads (`web/src/lib/coding.ts`, as v1's Worker answered them), over Forge's own handler. Forge's REST speaks its stored rows
 * (`threadId`, `status`, a `repo` string); the page wants a thread view with `id`, a `repo` object, a `slot` and an `environment`. Every route here reshapes what Forge answers and
 * leaves the rest of `/api/coding/**` (harness logins, the git broker, Gitea, the model gateway) to the inner handler. The live `events` stream follows the thread's transcript as Forge records it (a message at a time: a
 * command's output as it prints is not streamed). Not served: an environment build, which Forge has no counterpart for.
 */
import type { Forge, ThreadView } from "@pim/v2-forge/forge";
import { json, type Authenticate, type Handler } from "@pim/v2-forge/http/common";


const NO_ENVIRONMENT = { state: "none", key: null, source: null, builtAt: null, restoredFromKey: null, provisionMs: null, restoreMs: null, setupMs: null, snapshotMs: null, snapshotBytes: null, snapshotKept: null, readyFrom: null, preparedAt: null, rebuildRequested: false, toolchains: [], dependencies: [], testCommands: [], notes: [], services: [], cachePaths: [] };
/** The page's environment of a thread: what its setup script did in this workspace (Forge keeps no snapshots, so a prepared one is always set up again). */
const environmentOf = (t: Thread): Record<string, unknown> & { state: string; error?: string } => {
	const e = (t.provisioning as { environment?: { state: "ready" | "failed"; error?: string; setupMs?: number } } | null)?.environment;
	return e ? { ...NO_ENVIRONMENT, state: e.state === "failed" ? "failed" : "cached", readyFrom: e.state === "failed" ? null : "setup", setupMs: e.setupMs ?? null, ...(e.error ? { error: e.error } : {}) } : NO_ENVIRONMENT;
};
const NO_REBUILD = { error: "This deployment keeps no environment snapshots to rebuild", code: "conflict" };

/** What Forge says of how a thread is getting on (`Forge.progress`), for the page's unread dot and its place in the queue. */
type Progress = { lastTurnEndedAt: number | null; queuePosition: number | null };

/** Forge's reasons as the page names them: waiting for a pool slot is the queue's own line, and an expired wait says what it waited for. */
const reasonOf = (reason: string | null) => {
	switch (reason) {
		case "pool_full":
			return null;
		case "queue_timeout":
			return "queue_expired:slots_full";
		// What the page has words for: a workspace that couldn't be made or reached, and a run that was cut short and goes on.
		case "pool_unhealthy":
		case "provision_failed":
		case "checkout_failed":
			return "workspace";
		case "lost":
		case "resuming":
			return "interrupted";
		default:
			return reason;
	}
};

/** A thread row without what only Forge may read (see `Forge.status`). */
type Thread = Omit<ThreadView, "capabilities">;

const creator = (t: Thread) => (t.createdBy === t.ownerId || !t.chatId ? { type: "person" } : { type: "agent", agent: t.createdBy, chat: t.chatId });

/** A thread as the page's list reads it. */
function summary(t: Thread, progress: Progress) {
	return {
		id: t.threadId,
		url: `/coding/${t.threadId}`,
		repo: t.repo,
		ref: t.ref ?? "",
		branch: t.branch ?? "",
		task: t.task,
		state: t.state,
		stateReason: reasonOf(t.stateReason),
		queue: t.state === "queued" && progress.queuePosition !== null ? { position: progress.queuePosition, reason: "slots_full" } : null,
		createdBy: creator(t),
		parent: t.parentId,
		chat: t.chatId,
		harness: t.harness,
		spentUsd: t.spentUsd,
		budgetUsd: t.budgetUsd,
		createdAt: t.createdAt,
		updatedAt: t.updatedAt,
		// Forge's own names for the same, for a caller of the API.
		threadId: t.threadId,
		status: t.state,
		unread: t.lastSeenAt === null || t.updatedAt > t.lastSeenAt,
		lastTurnEndedAt: progress.lastTurnEndedAt,
		lastSeenAt: t.lastSeenAt,
	};
}

/** A thread as its page reads it. */
function view(t: Thread, progress: Progress, unpushed: { commits: number; sha: string; message: string; at: number } | null, activity?: object) {
	// Forge's own fields stay (a caller of the API reads `workspaceRef` and `lastPushedSha`); `Forge.status` already left out the nonce that signs the thread's grants.
	const raw = t;
	const environment = environmentOf(t);
	// A failed setup is shown, not hidden, while nothing else says what the thread is waiting on.
	const setupFailed = environment.state === "failed" && !t.stateReason && t.state !== "failed" && t.state !== "archived";
	const pool = t.placement?.pool ?? "";
	const provider = t.workspaceRef?.provider ?? t.placement?.provider ?? "";
	return {
		...raw,
		...summary(t, progress),
		threadId: t.threadId,
		status: t.state,
		stateReason: setupFailed ? "environment_failed" : reasonOf(t.stateReason),
		stateDetail: setupFailed ? (environment.error ?? null) : t.stateDetail,
		repo: { url: t.repo, ref: t.ref ?? "", branch: t.branch ?? "", baseSha: t.baseSha },
		profile: t.profile ?? { providerId: "", model: "" },
		resolvedProfile: t.resolvedProfile ?? (t.profile?.model ? { provider: t.profile.providerId, model: t.profile.model, source: "explicit" } : null),
		workspaceProvider: provider,
		provider,
		pool,
		placementReason: "priority",
		placement: t.placement ? { kind: "priority", pool, provider, priority: 0, skipped: [] } : null,
		providerKind: t.harness === "amp" ? "agent-hosted" : "workspace",
		orb: t.orb ?? null,
		cost: t.spentUsd,
		slot: t.workspaceRef && !t.computeTornDownAt ? "held" : t.state === "queued" ? "queued" : "none",
		currentOperation: t.state === "running" ? t.startOperation : null,
		inbox: 0,
		// What the page's Push button is for: the newest commit the git host doesn't have. Forge keeps no checkpoints of its own, so `seq` counts the commits waiting.
		checkpoint: unpushed && { seq: unpushed.commits, sha: unpushed.sha, message: unpushed.message, operationId: null, createdAt: unpushed.at },
		parentThread: t.parentId,
		...(activity ? { activity } : {}),
		environment,
	};
}

/** How many of a thread's latest messages the live stream's snapshot carries. */
const SNAPSHOT_ENTRIES = 100;

/** A message the thread recorded, as the pi entry the page's stream folds into its transcript (the page's own reducer reads `entry.model[0]`). */
const entryOf = (e: { seq: number | string; role: string | null; data: any; at: string | Date }) => {
	const timestamp = new Date(e.at).getTime();
	const d = e.data ?? {};
	const model =
		e.role === "user"
			? { role: "user", content: String(d.text ?? ""), timestamp }
			: e.role === "tool"
				? { role: "toolResult", toolCallId: String(d.toolCallId ?? ""), toolName: String(d.name ?? "tool"), content: [{ type: "text", text: String(d.text ?? "") }], isError: d.isError === true, timestamp }
				: e.role === "assistant"
					? { role: "assistant", content: [...(d.text ? [{ type: "text", text: String(d.text) }] : []), ...((d.toolCalls ?? []) as { id: string; name: string; arguments: unknown }[]).map((c) => ({ type: "toolCall", id: String(c.id), name: String(c.name), arguments: c.arguments ?? {} }))], timestamp, stopReason: "stop" }
					: null;
	return model ? { id: Number(e.seq), kind: "pi.message", model: [model] } : null;
};

/**
 * The page's live stream (`GET …/events`, newline-delimited JSON): a snapshot of the conversation so far, then each message the thread records as it does, with the run's start and end. Forge records a message when
 * pi or the CLI finishes it, so what the page follows is one message at a time, not the words as they are written or a command's output as it prints.
 */
function follow(forge: Forge, actor: Parameters<Forge["status"]>[0], id: string, signal: AbortSignal, pollMs: number): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let closed = false;
	return new ReadableStream({
		async start(controller) {
			const send = (message: object) => controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
			let after = 0;
			const drain = async () => {
				const entries: NonNullable<ReturnType<typeof entryOf>>[] = [];
				for (;;) {
					const rows = await forge.eventsAfter(actor, id, after, 500);
					for (const row of rows) {
						after = Number(row.seq);
						const entry = row.kind === "message" ? entryOf(row as never) : null;
						if (entry) entries.push(entry);
					}
					if (rows.length < 500) return entries;
				}
			};
			let running = (await forge.status(actor, id)).state === "running";
			// The page holds the whole transcript already and reads it again on a snapshot, so the latest of it is enough here.
			send({ type: "snapshot", entries: (await drain()).slice(-SNAPSHOT_ENTRIES), tools: [], ...(running ? { run: {} } : {}) });
			const stop = () => void (closed = true);
			signal.addEventListener("abort", stop, { once: true });
			while (!closed) {
				await new Promise((r) => setTimeout(r, pollMs));
				if (closed) break;
				try {
					const entries = await drain();
					const now = (await forge.status(actor, id)).state === "running";
					const events = [...(now && !running ? [{ type: "run_start" }] : []), ...entries.map((entry) => ({ type: "entry_appended", entry })), ...(!now && running ? [{ type: "run_end" }] : [])];
					running = now;
					if (events.length) send({ type: "events", events });
				} catch {
					// A read that failed is tried again at the next look; the page reconnects if this ends.
				}
			}
			signal.removeEventListener("abort", stop);
			try {
				controller.close();
			} catch {
				// Already closed by the page.
			}
		},
		cancel() {
			closed = true;
		},
	});
}

export type PageApproval = (ownerId: string, forgeApproval: string) => Promise<{ id: string; summary: string } | null>;

export function webCodingShapes(d: { forge: Forge; authenticate: Authenticate; inner: Handler; pageApproval: PageApproval; /** How often the live stream looks for what is new, in ms. */ followMs?: number }): Handler {
	return async (req) => {
		const url = new URL(req.url);
		const path = url.pathname;
		if (!path.startsWith("/api/coding/threads") && !path.startsWith("/api/coding/repos/")) return d.inner(req);
		const caller = await d.authenticate(req);
		// Whoever isn't signed in, or is a guest, is told so by the inner handler.
		if (!caller || caller.actor.role === "guest") return d.inner(req);
		const { actor } = caller;
		const forge = d.forge.scopedTo(actor.ownerId);
		const thread = async (id: string) => view(await forge.status(actor, id), await forge.progress(actor, id), await forge.unpushed(actor, id), await forge.activity(actor, id));
		let m: RegExpExecArray | null;

		if (path === "/api/coding/threads" && req.method === "GET") {
			const listed = await forge.list(actor, { archived: url.searchParams.get("archived") === "1" });
			return json(200, { threads: await Promise.all(listed.map(async (t) => summary(await forge.status(actor, t.threadId), await forge.progress(actor, t.threadId)))) });
		}
		if (path === "/api/coding/threads" && req.method === "POST") {
			const made = await d.inner(req);
			if (!made || made.status >= 300) return made;
			const started = (await made.json()) as { threadId: string };
			return json(made.status, { ...started, ...(await thread(started.threadId)) });
		}
		if ((m = /^\/api\/coding\/threads\/([^/]+)$/.exec(path)) && req.method === "GET") return d.inner(new Request(req.url, req)).then(async (r) => (r && r.status === 200 ? json(200, await thread(m![1]!)) : r));
		if ((m = /^\/api\/coding\/threads\/([^/]+)\/environment\/rebuild$/.exec(path)) && req.method === "POST") return json(409, NO_REBUILD);
		if ((m = /^\/api\/coding\/threads\/([^/]+)\/([a-z-]+)$/.exec(path))) {
			const id = m[1]!;
			switch (`${req.method} ${m[2]}`) {
				case "GET transcript":
					// `text` is the words alone, as Forge's own transcript pages give them.
					return json(200, { messages: (await forge.transcriptMessages(actor, id)).map((x) => ({ ...x, text: x.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n") })) });
				case "GET diff": {
					const r = await d.inner(req);
					if (!r || r.status !== 200) return r;
					const kept = (await r.json()) as { diff: string; since: string | null; head: string | null; truncated: boolean; unpushedOrb: boolean };
					return json(200, { since: kept.since, head: kept.head, diff: kept.diff, truncated: kept.truncated, ...(kept.unpushedOrb ? { unpushedOrb: true } : {}) });
				}
				case "GET tests": {
					const r = await d.inner(req);
					if (!r || r.status !== 200) return r;
					const { runs } = (await r.json()) as { runs: { seq: number; command: string; exit_code: number | null; output: string; at: string; summary: object | null }[] };
					return json(200, { runs: runs.map((x) => ({ seq: x.seq, command: x.command, exitCode: x.exit_code, timedOut: false, startedAt: new Date(x.at).getTime(), durationMs: 0, summary: x.summary, output: x.output })) });
				}
				case "GET events": {
					// The page's live stream; a caller that doesn't ask for one gets Forge's own list.
					const accept = req.headers.get("accept") ?? "";
					if (!accept.includes("ndjson") && !accept.includes("event-stream")) return d.inner(req);
					await forge.status(actor, id);
					return new Response(follow(forge, actor, id, req.signal, d.followMs ?? 700), { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
				}
				case "GET log": {
					// v1's log: the entries after `since`, and where to ask next.
					const since = Number(url.searchParams.get("since") ?? 0);
					if (!Number.isInteger(since) || since < 0) return json(400, { error: "since must be a log entry's seq", code: "invalid" });
					const events = await forge.eventsAfter(actor, id, since);
					return json(200, { events, next: Number(events.at(-1)?.seq ?? since) });
				}
				case "POST push": {
					// The page reads v1's answer: the approval the person decides (the one in their list), and the branch and commit it is for. A push nothing stands in the way of is done already.
					const r = await d.inner(req);
					if (!r || (r.status >= 300 && r.status !== 202)) return r;
					const pushed = (await r.json()) as { status: string; approvalId?: string; outcome?: string; sha?: string; branch?: string };
					if (pushed.status === "done") {
						if (pushed.outcome === "unchanged") return json(409, { error: "There is nothing new to push", code: "nothing_to_push" });
						return json(200, { approval: "", status: "approved", branch: pushed.branch ?? "", head: pushed.sha ?? "", bytes: 0, summary: `Pushed ${pushed.branch ?? ""}` });
					}
					const asked = pushed.approvalId ? await d.pageApproval(actor.ownerId, pushed.approvalId) : null;
					if (!asked) return json(409, { error: "The push's approval could not be shown", code: "conflict" });
					return json(202, { approval: asked.id, status: "pending", branch: (await forge.status(actor, id)).branch ?? "", head: (await forge.unpushed(actor, id))?.sha ?? "", bytes: 0, summary: asked.summary });
				}
				case "POST seen": {
					const r = await d.inner(req);
					return r && r.status < 300 ? json(200, { seen: true }) : r;
				}
				case "POST steer":
				case "POST continue":
				case "POST abort":
				case "POST cancel":
				case "POST archive": {
					const r = await d.inner(req);
					return r && r.status < 300 ? json(r.status, { ...((await r.json()) as object), ...(await thread(id)) }) : r;
				}
			}
		}
		if (/^\/api\/coding\/repos\//.test(path)) {
			const r = await d.inner(req);
			if (!r || r.status !== 200) return r;
			const s = (await r.json()) as { repo: string; setupScript: string; updatedAt: number | null };
			return json(200, { repo: s.repo, setupScript: s.setupScript === "" ? null : s.setupScript, updatedAt: s.updatedAt });
		}
		return d.inner(req);
	};
}
