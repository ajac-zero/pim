// The computer host (`pim-host`) against a real PostgreSQL with every migration applied: the admin pairs it, it asks for work with its own `pimh_` token, a person's computer is made for
// them (and only them), the `pimc_` token it connects with is made when the host takes the request and replaced when a request is taken again, and a person's `/api/computer` says
// what the host keeps for them. A token that is not the host's, a person, and a pairing that was forgotten are all refused.
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { createGate } from "@pim/v2-app/gate";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { computerRoutes } from "../src/compat/computer.ts";
import { hostRoutes, managedComputerRoutes } from "../src/hostops/routes.ts";
import { createStack, type Stack } from "./support/stack.ts";

describe("the computer host", () => {
	let stack: Stack;
	let app: App;
	let server: Server;
	let base: string;
	const people: Record<string, { token: string; ownerId: string }> = {};
	const call = async (bearer: string, method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		const text = await res.text();
		return { status: res.status, json: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
	};
	const as = (who: string, method: string, path: string, body?: unknown) => call(people[who]!.token, method, path, body);
	const sync = (hostToken: string, body: object = {}) => call(hostToken, "POST", "/api/computer-host/sync", body);
	/** A computer's socket, as the Relay sees it. */
	const connectsWith = (token: string) => app.relay.connect(token, { send: () => undefined, close: () => undefined });

	beforeAll(async () => {
		stack = await createStack();
		app = new App(connectApp(stack.url("gate"), 6), new MemoryObjectStore());
		const ada = await app.identity.register({ username: "ada", bootstrap: await app.identity.issueClaim("bootstrap", null, 3_600_000) });
		await app.identity.setRegistrationOpen({ kind: "user", ownerId: ada.ownerId, role: "admin", sessionId: "s" }, true);
		for (const [name, a] of [["ada", ada], ["bob", await app.identity.register({ username: "bob" })], ["cy", await app.identity.register({ username: "cy" })], ["dee", await app.identity.register({ username: "dee" })]] as const) people[name] = { ownerId: a.ownerId, token: await app.identity.createSession(a.ownerId) };
		server = createGate(app, { first: [...hostRoutes(), ...managedComputerRoutes(computerRoutes())] });
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	}, 120_000);
	afterAll(async () => {
		await new Promise<void>((r) => server?.close(() => r()));
		await app?.db.end();
		await stack?.drop();
	});

	let hostToken = "";
	let bobsRequest: { id: string; name: string; token: string };

	it("is paired by the admin alone, and a person's computer stays their own until it is", async () => {
		expect((await as("bob", "POST", "/api/admin/computer-host")).status).toBe(403);
		expect((await as("ada", "GET", "/api/admin/computer-host")).json).toMatchObject({ paired: false, connected: false, machines: 0 });
		// Without a host nothing is asked for anyone, and the person's own computer is theirs to pair.
		expect((await as("dee", "GET", "/api/computer")).json).toMatchObject({ state: "none", managed: false });
		expect((await as("dee", "POST", "/api/computer", { managed: true })).status).toBe(404);

		const paired = await as("ada", "POST", "/api/admin/computer-host");
		expect(paired.status).toBe(201);
		hostToken = paired.json.token;
		expect(hostToken).toMatch(/^pimh_/);
		expect(paired.json).toMatchObject({ paired: true, connected: false });
		// Only its digest is kept.
		const kept = (await stack.admin.query("SELECT token_hash, kind, scopes FROM pim_app.token_consumers WHERE kind = 'host'")).rows;
		expect(kept).toHaveLength(1);
		expect(JSON.stringify(kept)).not.toContain(hostToken);
		expect(kept[0]).toMatchObject({ scopes: ["host:sync"] });
	});

	it("refuses a token that is not the host's, and a check takes no work", async () => {
		expect((await sync("pimh_nope")).status).toBe(401);
		expect((await sync(people.bob!.token)).status).toBe(401);
		const own = (await as("cy", "POST", "/api/computer", {})).json.token; // cy pairs their own, before being asked about
		expect((await sync(own)).status).toBe(401);
		await as("cy", "DELETE", "/api/computer");
		expect((await call("", "POST", "/api/computer-host/sync", {})).status).toBe(401);
		expect((await sync(hostToken, { check: true })).json).toEqual({ requests: [] });
		expect((await as("ada", "GET", "/api/admin/computer-host")).json.seenAt).toBeNull();
	});

	it("makes a computer for a person who looks at theirs, with a token only that person's space accepts", async () => {
		// Looking at it asks for it, as in v1; it is managed and offline until the host has made it.
		const first = (await as("bob", "GET", "/api/computer")).json;
		expect(first).toMatchObject({ state: "offline", managed: true, computer: null, error: null });
		expect(typeof first.pairedAt).toBe("number");
		expect((await as("ada", "GET", "/api/admin/computer-host")).json.pending).toBe(1);

		const took = (await sync(hostToken, { image: "pim:test", kind: "container", version: "9.9", machines: [{ name: "pim-o-0123456789abcdef01234567", running: true }] })).json;
		expect(took.requests).toHaveLength(1);
		bobsRequest = took.requests[0];
		expect(bobsRequest).toMatchObject({ op: "create", name: `pim-${people.bob!.ownerId.replace("_", "-")}`, token: expect.stringMatching(/^pimc_/) });
		expect(await as("ada", "GET", "/api/admin/computer-host")).toMatchObject({ json: { connected: true, image: "pim:test", kind: "container", version: "9.9", machines: 1, running: 1, pending: 1 } });

		// The token connects as bob and as nobody else, and nothing else of Pim opens with it.
		const link = await connectsWith(bobsRequest.token);
		expect(link.ownerId).toBe(people.bob!.ownerId);
		expect((await call(bobsRequest.token, "GET", "/api/sessions")).status).not.toBe(200);
		expect((await sync(bobsRequest.token)).status).toBe(401);
		expect((await stack.admin.query("SELECT name, machine FROM pim_app.computers WHERE owner_id = $1 AND revoked_at IS NULL", [people.bob!.ownerId])).rows).toEqual([{ name: bobsRequest.name, machine: bobsRequest.name }]);
		// No computer's token is stored in the clear.
		expect(JSON.stringify((await stack.admin.query("SELECT * FROM pim_app.token_consumers")).rows) + JSON.stringify((await stack.admin.query("SELECT * FROM pim_app.computer_requests")).rows)).not.toContain(bobsRequest.token);

		// Reported done, the request is gone; the person's computer is the host's, permanent, and not replaceable by one of their own.
		await sync(hostToken, { results: [{ id: bobsRequest.id }] });
		expect((await as("ada", "GET", "/api/admin/computer-host")).json.pending).toBe(0);
		expect((await as("bob", "GET", "/api/computer")).json).toMatchObject({ managed: true, state: "online" });
		expect((await as("bob", "DELETE", "/api/computer")).status).toBe(409);
		expect((await as("bob", "POST", "/api/computer", {})).status).toBe(409);
		expect((await as("bob", "POST", "/api/computer", {})).json.message).toMatch(/keeps a computer for you/);
	});

	it("gives a request again after twenty minutes with a new token that replaces the old", async () => {
		await as("cy", "GET", "/api/computer");
		const [r1] = (await sync(hostToken)).json.requests;
		expect(r1.name).toBe(`pim-${people.cy!.ownerId.replace("_", "-")}`);
		expect((await sync(hostToken)).json.requests).toEqual([]); // taken: not given again at once
		await stack.admin.query("UPDATE pim_app.computer_requests SET taken_at = now() - interval '21 minutes' WHERE owner_id = $1", [people.cy!.ownerId]);
		const [r2] = (await sync(hostToken)).json.requests;
		expect(r2.id).toBe(r1.id);
		expect(r2.token).not.toBe(r1.token);
		await expect(connectsWith(r1.token)).rejects.toThrow();
		expect((await connectsWith(r2.token)).ownerId).toBe(people.cy!.ownerId);
	});

	it("tells a person why their computer could not be made, and makes it again when they ask", async () => {
		await as("dee", "GET", "/api/computer");
		const [r] = (await sync(hostToken)).json.requests;
		await sync(hostToken, { results: [{ id: r.id, error: "Making it failed (cua exited 1): no space left" }] });
		expect((await as("dee", "GET", "/api/computer")).json).toMatchObject({ managed: true, error: "Making it failed (cua exited 1): no space left" });
		// Not retaken by itself.
		await stack.admin.query("UPDATE pim_app.computer_requests SET taken_at = now() - interval '2 hours' WHERE owner_id = $1", [people.dee!.ownerId]);
		expect((await sync(hostToken)).json.requests).toEqual([]);
		const again = await as("dee", "POST", "/api/computer", { managed: true });
		expect(again.status).toBe(201);
		expect(again.json).toMatchObject({ managed: true, error: null });
		expect((await sync(hostToken)).json.requests).toHaveLength(1);
	});

	it("removes the machine of a person who is gone, and drops a request for one who is suspended", async () => {
		await app.identity.setStatus({ kind: "user", ownerId: people.ada!.ownerId as never, role: "admin", sessionId: "s" }, people.bob!.ownerId, "deleting", "removed by an admin");
		const answer = (await sync(hostToken, { machines: [{ name: bobsRequest.name, running: true }, { name: "something-else", running: true }] })).json;
		expect(answer.requests).toEqual([expect.objectContaining({ op: "delete", name: bobsRequest.name })]);
		// A removal that failed is given again; one reported done goes.
		await sync(hostToken, { results: [{ id: answer.requests[0].id, error: "busy" }] });
		await stack.admin.query("UPDATE pim_app.computer_requests SET taken_at = now() - interval '21 minutes' WHERE owner_id = $1", [people.bob!.ownerId]);
		const retaken = (await sync(hostToken)).json.requests;
		expect(retaken).toEqual([expect.objectContaining({ op: "delete" })]);
		await sync(hostToken, { results: [{ id: retaken[0].id }] });
		expect((await stack.admin.query("SELECT 1 FROM pim_app.computer_requests WHERE owner_id = $1", [people.bob!.ownerId])).rowCount).toBe(0);
	});

	it("stops working when the admin forgets it, and the computers it made go on", async () => {
		expect((await as("ada", "DELETE", "/api/admin/computer-host")).json).toMatchObject({ paired: false });
		expect((await sync(hostToken)).status).toBe(401);
		expect((await stack.admin.query("SELECT revoked_at FROM pim_app.token_consumers WHERE kind = 'host'")).rows[0]!.revoked_at).not.toBeNull();
		// Cy's computer was made by it and is still theirs; with no host, theirs is a computer like any other.
		expect((await as("cy", "GET", "/api/computer")).json.managed).toBe(true);
		expect((await call(hostToken, "GET", "/pim-host.ts")).status).toBe(200);
	});
});
