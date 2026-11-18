/**
 * The HTTP surface of the computer host and of host operations, in the shapes the web app and the two daemons (`computer/pim-host.ts`, `sandbox-manager/hostopsd`) were built for:
 *
 *   POST /api/computer-host/sync            the host asking for work, with its `pimh_` token
 *   GET / POST / DELETE /api/admin/computer-host   the admin pairing the host and seeing it
 *   GET /pim-host.ts                        what installs and updates the host
 *   /api/hostops/{status,audit,credential,ops}      the admin reading, and the refusal of everyone who is not the majordomo
 *   GET /api/admin/release, POST /api/hostops/update   the admin's view of the version and the update check, and the button that updates the stack
 *   POST /api/hostops/agent/{enroll,poll,result}    the daemon, with its `pimhostops_` credential
 *
 * and what a person's `/api/computer` answers where a host keeps their computer (`managedComputerRoutes`, which wraps `compat/computer.ts`'s routes and leaves them as they are
 * where no host is paired).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { App } from "@pim/v2-app/app";
import { BadRequestError, ForbiddenError, NotFoundError, PimError, UnauthorizedError } from "@pim/v2-app/errors";
import { type Ctx, ok, type Reply, type Route, route } from "@pim/v2-app/http";
import { ComputerHost, readSync } from "./computer-host.ts";
import { readRecord, releaseView } from "../update-check.ts";
import { AUDIT_ROWS, type HostdResult, type HostOpData, HostOps, MAX_DATA_BYTES, MAX_POLL_WAIT_MS, MAX_SUMMARY } from "./service.ts";

const noStore = { "cache-control": "no-store, private" };
type Services = { host: ComputerHost; hostops: HostOps };
const held = new WeakMap<App, Services>();

/** The services over an application's database, made once per process. `env` is read once, when the first request comes. */
export function hostServices(app: App, env: Readonly<Record<string, string | undefined>> = process.env): Services {
	let s = held.get(app);
	if (!s) {
		s = { host: new ComputerHost(app.db, app.identity, (ownerId) => app.relay.disconnect(ownerId, 4003, "A new computer was set up")), hostops: new HostOps(app.db, { enrollSecret: env.PIM_HOSTOPS_ENROLL_TOKEN || env.PIM_CODING_MANAGER_TOKEN }) };
		held.set(app, s);
	}
	return s;
}

const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const bearer = (ctx: Ctx) => (ctx.req.headers.authorization?.startsWith("Bearer ") ? ctx.req.headers.authorization.slice(7).trim() : "");
const addressOf = (ctx: Ctx) => String(ctx.req.headers["x-pim-client-ip"] ?? ctx.req.socket.remoteAddress ?? "");

export function hostRoutes(options: { hostSource?: string; env?: Readonly<Record<string, string | undefined>> } = {}): Route[] {
	const env = options.env ?? process.env;
	const source = options.hostSource ?? process.env.PIM_HOST_SOURCE ?? fileURLToPath(new URL("../../../../computer/pim-host.ts", import.meta.url));
	const admin = async (ctx: Ctx) => {
		const p = await ctx.principal();
		await ctx.app.identity.authz.enforce(p, "admin:compute");
		return p;
	};
	/** The admin, signed in to the app: what reads host operations and issues the daemon's credential. */
	const adminSession = async (ctx: Ctx) => {
		const p = await ctx.principal();
		await ctx.app.identity.authz.enforce(p, "admin:settings");
		if (p.kind !== "user") throw new ForbiddenError("hostops", "session-only");
		return p;
	};
	return [
		// ---- the computer host ----
		route("POST", "/api/computer-host/sync", async (ctx) => {
			const { host } = hostServices(ctx.app);
			const p = await host.authenticate(bearer(ctx));
			return ok(await host.sync(p, readSync(await ctx.json())), 200, noStore);
		}),
		route("GET", "/api/admin/computer-host", async (ctx) => (await admin(ctx), ok(await hostServices(ctx.app).host.status(), 200, noStore))),
		route("POST", "/api/admin/computer-host", async (ctx) => {
			const { host } = hostServices(ctx.app);
			const token = await host.pair(await admin(ctx));
			return ok({ ...(await host.status()), token }, 201, noStore);
		}),
		route("DELETE", "/api/admin/computer-host", async (ctx) => {
			const { host } = hostServices(ctx.app);
			await host.forget(await admin(ctx));
			return ok(await host.status(), 200, noStore);
		}),
		// Public, as the computer's own is: a machine fetches it before it has a token, and again to update itself.
		route("GET", "/pim-host.ts", async () => ({ status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" }, raw: await readFile(source).catch(() => { throw new NotFoundError("This deployment does not carry pim-host.ts (set PIM_HOST_SOURCE)"); }) })),

		// ---- host operations: what a person or a token may do is read and nothing else; an operation is asked for by the majordomo's tool only ----
		route("POST", "/api/hostops/ops", async (ctx) => {
			const { hostops } = hostServices(ctx.app);
			const p = await ctx.maybePrincipal().catch(() => null);
			const body: Record<string, any> = await ctx.json().catch(() => ({}));
			// Nobody can ask over the API, the admin included: the refusal is the answer, and it is kept.
			await hostops.enqueue(p ? { kind: p.kind === "user" ? "session" : "token", ownerId: p.ownerId } : { kind: "anonymous", address: addressOf(ctx) }, body.op, body.args);
			throw new PimError(403, "forbidden", "Only the admin's majordomo can run operations on this Pim's host.");
		}),
		// What runs, what the last check found, whether a daemon is there to update the stack, and the newest update (while it runs, and for an hour after).
		route("GET", "/api/admin/release", async (ctx) => {
			await adminSession(ctx);
			const { hostops } = hostServices(ctx.app);
			const status = await hostops.status();
			return ok({ ...releaseView(env, await readRecord(ctx.app.db)), daemon: { online: status.credential.present && status.agent.lastSeenAt !== null && Date.now() - status.agent.lastSeenAt < 60_000 }, update: await hostops.latestUpdate() }, 200, noStore);
		}),
		// The admin pressing "Update": the press is the approval for this one operation.
		route("POST", "/api/hostops/update", async (ctx) => {
			const p = await adminSession(ctx);
			const body: Record<string, unknown> = await ctx.json().catch(() => ({}));
			return ok(await hostServices(ctx.app).hostops.requestUpdate(p.ownerId, typeof body.tag === "string" && body.tag !== "" ? body.tag : undefined), 201, noStore);
		}),
		route("GET", "/api/hostops/status", async (ctx) => (await adminSession(ctx), ok(await hostServices(ctx.app).hostops.status(), 200, noStore))),
		route("GET", "/api/hostops/audit", async (ctx) => {
			await adminSession(ctx);
			const limit = Number(ctx.url.searchParams.get("limit") ?? 100);
			if (!isInt(limit, 1, AUDIT_ROWS)) throw new BadRequestError(`limit must be a whole number from 1 to ${AUDIT_ROWS}`);
			return ok({ audit: await hostServices(ctx.app).hostops.audit(limit) }, 200, noStore);
		}),
		route("POST", "/api/hostops/credential", async (ctx) => ok(await hostServices(ctx.app).hostops.issueCredential((await adminSession(ctx)).ownerId), 201, noStore)),
		route("DELETE", "/api/hostops/credential", async (ctx) => ok({ revoked: await hostServices(ctx.app).hostops.revokeCredential((await adminSession(ctx)).ownerId) }, 200, noStore)),
		route("GET", "/api/hostops/ops/:id", async (ctx) => {
			await adminSession(ctx);
			const found = await hostServices(ctx.app).hostops.get(ctx.params[0]!);
			if (!found) throw new NotFoundError("No such operation");
			return ok(found, 200, noStore);
		}),

		// ---- the daemon, with its credential as the bearer and nothing else ----
		route("POST", "/api/hostops/agent/enroll", async (ctx) => {
			const enrolled = await hostServices(ctx.app).hostops.enroll(bearer(ctx), addressOf(ctx));
			return enrolled ? ok(enrolled, 201, noStore) : { status: 403, body: { error: "revoked" } };
		}),
		route("POST", "/api/hostops/agent/poll", async (ctx) => {
			const token = bearer(ctx);
			if (!token) throw new UnauthorizedError("Unauthorized");
			const body = await ctx.json();
			const waitMs = body.waitMs ?? MAX_POLL_WAIT_MS;
			if (!isInt(waitMs, 0, MAX_POLL_WAIT_MS)) throw new BadRequestError(`waitMs must be a whole number from 0 to ${MAX_POLL_WAIT_MS}`);
			const text = (v: unknown, name: string) => {
				if (v === undefined || v === null) return null;
				if (typeof v !== "string" || v.length > 200) throw new BadRequestError(`${name} must be a string of up to 200 characters`);
				return v;
			};
			const polled = await hostServices(ctx.app).hostops.poll(token, { agentVersion: text(body.agentVersion, "agentVersion"), commit: text(body.commit, "commit") }, waitMs);
			if (polled === "unauthorized") throw new UnauthorizedError("Unauthorized");
			return polled.op ? ok({ op: polled.op }, 200, noStore) : { status: 204, raw: "", headers: noStore };
		}),
		route("POST", "/api/hostops/agent/result", async (ctx) => {
			const token = bearer(ctx);
			if (!token) throw new UnauthorizedError("Unauthorized");
			const { id, ok: succeeded, state, summary, data } = await ctx.json();
			if (typeof id !== "string" || id === "") throw new BadRequestError("id must be the operation's id");
			if (typeof succeeded !== "boolean") throw new BadRequestError("ok must be true or false");
			if (state !== "succeeded" && state !== "failed" && state !== "rolled_back") throw new BadRequestError("state must be succeeded, failed or rolled_back");
			if (succeeded !== (state === "succeeded")) throw new BadRequestError("ok must be true exactly when state is succeeded");
			if (typeof summary !== "string" || summary.length > MAX_SUMMARY) throw new BadRequestError(`summary must be a string of up to ${MAX_SUMMARY} characters`);
			if (data === null || typeof data !== "object" || Array.isArray(data)) throw new BadRequestError("data must be an object");
			if (Buffer.byteLength(JSON.stringify(data)) > MAX_DATA_BYTES) throw new BadRequestError(`data must be at most ${MAX_DATA_BYTES} bytes of JSON`);
			const reported = await hostServices(ctx.app).hostops.result(token, { id, ok: succeeded, state, summary, data: data as HostOpData } satisfies HostdResult);
			if (!reported.op) throw new PimError(reported.status, reported.status === 401 ? "unauthorized" : reported.status === 404 ? "not_found" : "conflict", reported.error ?? "Failed");
			return ok(reported.op, 200, noStore);
		}),
	];
}

/**
 * `compat/computer.ts`'s routes, with a person's computer where the host keeps one: asked for the first time `/api/computer` is looked at, made by the host, permanent for as long as
 * the person is here (it cannot be removed or replaced by one of their own), and set up again on `{ managed: true }`. Where no host is paired every route is the original.
 */
export function managedComputerRoutes(inner: Route[]): Route[] {
	const find = (method: string, path: string) => {
		const r = inner.find((x) => x.method === method && x.pattern.test(path));
		if (!r) throw new Error(`compat/computer.ts has no ${method} ${path}`);
		return r;
	};
	const [get, post, del] = [find("GET", "/api/computer"), find("POST", "/api/computer"), find("DELETE", "/api/computer")];
	/** The person's computer as the app reads it: the inner status, with what only the host knows. Where a host is paired, looking at it asks for it. */
	const shown = async (ctx: Ctx, reply: Reply, hasHost: boolean): Promise<Reply> => {
		const { host } = hostServices(ctx.app);
		const body = reply.body as Record<string, any>;
		const p = await ctx.principal();
		let managed = await host.managedState(p.ownerId);
		if (hasHost && body.state === "none" && !managed.request && !managed.machine) {
			// A guest has no computer, and nothing is asked for them.
			if (await ctx.app.identity.authz.enforce(p, "computer:use").then(() => true, () => false)) await host.request(p.ownerId);
			managed = await host.managedState(p.ownerId);
		}
		// Made but not set up: the host's error is the person's to see until they ask again.
		if (managed.machine) return { ...reply, body: { ...body, managed: true, error: managed.request?.error ?? body.error } };
		if (body.state === "none" && managed.request) return { ...reply, body: { ...body, state: "offline", managed: true, pairedAt: managed.request.requestedAt, error: managed.request.error } };
		return reply;
	};
	return inner.map((r): Route => {
		if (r !== get && r !== post && r !== del) return r;
		return {
			...r,
			run: async (ctx) => {
				const { host } = hostServices(ctx.app);
				const hasHost = await host.has();
				if (r === get) return shown(ctx, await r.run(ctx), hasHost);
				const p = await ctx.principal();
				const machine = (await host.managedState(p.ownerId)).machine;
				if (r === del) {
					if (machine) throw new PimError(409, "conflict", "This Pim keeps this computer for you for as long as you're here: it can't be removed.");
					return r.run(ctx);
				}
				if (!hasHost && !machine) return r.run(ctx);
				const body = await ctx.json();
				// Asking for the host's computer again sets it up again, as after it failed to be.
				if (body.managed === true && hasHost) {
					await ctx.app.identity.authz.enforce(p, "computer:use");
					await host.request(p.ownerId);
					return { ...(await shown(ctx, await get.run({ ...ctx, json: async () => body }), hasHost)), status: 201 };
				}
				throw host.conflict();
			},
		};
	});
}
