// The real `computer/pim-host.ts`, with the docker backend and a stand-in `docker`, against the Gate: it asks for work with its own token, makes a container for the person who asked for a
// computer (the container's token reaching `docker` only on standard input, with the hardening of the local-computer profile, on a network of its own and with no credential of the stack), reports
// it done, keeps the containers it made, and removes a person's container and files when their account is gone.
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { createGate } from "@pim/v2-app/gate";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { computerRoutes } from "../src/compat/computer.ts";
import { hostRoutes, managedComputerRoutes } from "../src/hostops/routes.ts";
import { waitFor } from "../../v2-runtime/test/support/rig.ts";
import { createStack, type Stack } from "./support/stack.ts";

const HOST = fileURLToPath(new URL("../../../computer/pim-host.ts", import.meta.url));

describe("pim-host with the docker backend", () => {
	let stack: Stack;
	let app: App;
	let server: Server;
	let base: string;
	let host: ChildProcess | undefined;
	let dir: string;
	let admin: { token: string; ownerId: string };
	let bob: { token: string; ownerId: string };
	const api = async (who: { token: string }, method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${who.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		return { status: res.status, json: (await res.json().catch(() => null)) as any };
	};
	const log = () => (existsSync(join(dir, "docker.log")) ? readFileSync(join(dir, "docker.log"), "utf8").split("\n").filter(Boolean) : []);

	beforeAll(async () => {
		stack = await createStack();
		app = new App(connectApp(stack.url("gate"), 6), new MemoryObjectStore());
		const ada = await app.identity.register({ username: "ada", bootstrap: await app.identity.issueClaim("bootstrap", null, 3_600_000) });
		await app.identity.setRegistrationOpen({ kind: "user", ownerId: ada.ownerId, role: "admin", sessionId: "s" }, true);
		const b = await app.identity.register({ username: "bob" });
		admin = { ownerId: ada.ownerId, token: await app.identity.createSession(ada.ownerId) };
		bob = { ownerId: b.ownerId, token: await app.identity.createSession(b.ownerId) };
		server = createGate(app, { first: [...hostRoutes(), ...managedComputerRoutes(computerRoutes())] });
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		// A `docker` that records what it was asked and what it was given on standard input, and lists the containers it was told to make.
		dir = mkdtempSync(join(tmpdir(), "pim-host-"));
		writeFileSync(join(dir, "docker"), `#!/bin/sh
echo "$*" >> "${dir}/docker.log"
case "$1" in
version) echo 29.0.0 ;;
ps) [ -f "${dir}/ps" ] && cat "${dir}/ps" ;;
run) cat > "${dir}/run.stdin"; printf '{"Names":"%s","State":"running"}\\n' "$(echo "$*" | sed -E 's/.*--name ([^ ]+).*/\\1/')" >> "${dir}/ps" ;;
rm) grep -v "\\"$3\\"" "${dir}/ps" > "${dir}/ps.next" 2>/dev/null; mv "${dir}/ps.next" "${dir}/ps" 2>/dev/null; echo "Error response from daemon: No such container: $3" >&2; exit 1 ;;
esac
exit 0
`);
		chmodSync(join(dir, "docker"), 0o755);
	}, 120_000);
	afterAll(async () => {
		host?.kill("SIGKILL");
		await new Promise<void>((r) => server?.close(() => r()));
		await app?.db.end();
		await stack?.drop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("makes a hardened container for a person who asked for a computer, and removes it with its files when they are gone", async () => {
		const hostToken = (await api(admin, "POST", "/api/admin/computer-host")).json.token as string;
		expect((await api(bob, "GET", "/api/computer")).json).toMatchObject({ managed: true, state: "offline" });
		host = spawn(process.execPath, [HOST, "--url", base, "--token", hostToken, "--backend", "docker", "--image", "pim:test", "--docker", join(dir, "docker"), "--computer-url", "http://host.docker.internal:8088", "--cpu", "2", "--memory", "4GB"], { stdio: ["ignore", openSync(join(dir, "host.log"), "a"), openSync(join(dir, "host.log"), "a")], env: { ...process.env, HOME: dir, PIM_HOST_INTERVAL_MS: "300", PIM_HOST_LIST_MS: "300" } });
		const name = `pim-${bob.ownerId.replace("_", "-")}`;
		await waitFor("the container to be made", async () => (log().find((l) => l.startsWith("run ")) && existsSync(join(dir, "ps")) ? true : undefined), 15_000).catch((error) => {
			throw new Error(`${error.message}; the host said: ${existsSync(join(dir, "host.log")) ? readFileSync(join(dir, "host.log"), "utf8").slice(-1500) : "nothing"}`);
		});
		const run = log().find((l) => l.startsWith("run "))!;
		expect(run).toContain(`--name ${name}`);
		for (const flag of ["--read-only", "--cap-drop ALL", "--security-opt no-new-privileges:true", "--user node", "--network pim-computers", "--cpus 2", "--memory 4g", `-v ${name}-files:/workspace`, "--entrypoint node pim:test /app/computer/pim-computer.ts", "--env-file /dev/stdin"]) expect(run, flag).toContain(flag);
		// No Docker socket, no host path, no stack network, and no token on the command line: it came on standard input.
		expect(run).not.toMatch(/docker\.sock|--privileged|--network (host|pim_)|pimc_/);
		const stdin = readFileSync(join(dir, "run.stdin"), "utf8");
		expect(stdin).toMatch(/^PIM_URL=http:\/\/host\.docker\.internal:8088$/m);
		const token = /^PIM_COMPUTER_TOKEN=(pimc_\S+)$/m.exec(stdin)![1]!;
		expect(stdin).not.toMatch(/DATABASE|NATS|KEK|S3|PASSWORD/);
		// It is the person's computer, for them only, and reported done.
		expect((await app.relay.connect(token, { send: () => undefined, close: () => undefined })).ownerId).toBe(bob.ownerId);
		await waitFor("the request to be done", async () => ((await api(admin, "GET", "/api/admin/computer-host")).json.pending === 0 ? true : undefined), 30_000);
		expect((await api(admin, "GET", "/api/admin/computer-host")).json).toMatchObject({ connected: true, kind: "container", image: "pim:test", machines: 1, running: 1 });

		// Their account goes: the host sees its machine of theirs belongs to nobody, and removes the container and its volume.
		await app.identity.setStatus({ kind: "user", ownerId: admin.ownerId as never, role: "admin", sessionId: "s" }, bob.ownerId, "deleting", "removed by an admin");
		await waitFor("the container and its files to be removed", async () => (log().some((l) => l === `volume rm -f ${name}-files`) ? true : undefined), 30_000);
		expect(log()).toContain(`rm -f ${name}`);
	}, 90_000);
});
