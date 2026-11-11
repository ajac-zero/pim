import { execFile, spawn } from "node:child_process";
import { createServer, type RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { workspaceCredentialHelper } from "../src/coding/git-broker/workspace-credential";

const exec = promisify(execFile);

it.each(["http", "https"])("fetches and pulls through an %s broker and proxy, renews credentials, and refuses expired grants", async (protocol) => {
	const root = await mkdtemp(join(tmpdir(), "pim-git-"));
	const home = join(root, "home");
	await mkdir(home);
	const env = { ...process.env, HOME: home, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
	const git = (cwd: string, ...args: string[]) => exec("git", args, { cwd, env });
	const source = join(root, "source");
	await mkdir(source);
	await git(source, "init", "-b", "main");
	await git(source, "config", "user.email", "test@example.test");
	await git(source, "config", "user.name", "Test");
	await writeFile(join(source, "a.txt"), "first");
	await git(source, "add", ".");
	await git(source, "commit", "-m", "Initial");
	const bare = join(root, "demo.git");
	await git(root, "clone", "--bare", source, bare);
	let token = "pimgit_initial.grant";
	let renewals = 0;
	let expired = false;
	const requests: string[] = [];
	const handler: RequestListener = async (req, res) => {
		const requestUrl = new URL(req.url!, "http://broker.test");
		const requestPath = requestUrl.pathname + requestUrl.search;
		requests.push(requestPath);
		const auth = req.headers.authorization;
		if (expired || (auth !== `Bearer ${token}` && auth !== `Basic ${Buffer.from("pim:" + token).toString("base64")}`)) {
			res.writeHead(401, { "www-authenticate": 'Basic realm="Pim git broker"' }).end();
			return;
		}
		if (requestPath === "/demo.git/credential") {
			token = `pimgit_renewed${++renewals}.grant`;
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token }));
			return;
		}
		if (requestPath.includes("receive-pack")) {
			res.writeHead(403).end();
			return;
		}
		// Real Git's smart HTTP backend, behind the same credential challenge as the broker.
		const url = requestUrl;
		const backend = spawn("git", ["http-backend"], { env: {
			...env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1",
			PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
			REQUEST_METHOD: req.method!, CONTENT_TYPE: req.headers["content-type"] ?? "",
		} });
		let buffered = Buffer.alloc(0);
		let headersSent = false;
		backend.stdout.on("data", (chunk: Buffer) => {
			if (headersSent) return void res.write(chunk);
			buffered = Buffer.concat([buffered, chunk]);
			const end = buffered.indexOf("\r\n\r\n");
			if (end < 0) return;
			const headers = Object.fromEntries(buffered.subarray(0, end).toString().split("\r\n").map(line => {
				const at = line.indexOf(":");
				return [line.slice(0, at), line.slice(at + 1).trim()];
			}));
			res.writeHead(200, headers);
			headersSent = true;
			res.write(buffered.subarray(end + 4));
		});
		backend.on("close", () => res.end());
		req.pipe(backend.stdin);
	};
	const server = createServer(handler);
	let tlsServer;
	const tunnels = new Set<Duplex>();
	if (protocol === "https") {
		const cert = join(root, "cert.pem");
		const key = join(root, "key.pem");
		await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=broker.test",
			"-addext", "subjectAltName=DNS:broker.test", "-keyout", key, "-out", cert, "-days", "1"]);
		tlsServer = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, handler);
		await new Promise<void>(resolve => tlsServer!.listen(0, "127.0.0.1", resolve));
		Object.assign(env, { NODE_EXTRA_CA_CERTS: cert, GIT_SSL_CAINFO: cert });
		server.on("connect", (req, socket, head) => {
			expect(req.headers.authorization).toBeUndefined();
			tunnels.add(socket);
			const target = connect((tlsServer!.address() as { port: number }).port, "127.0.0.1", () => {
				socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length) target.write(head);
				socket.pipe(target);
				target.pipe(socket);
			});
			tunnels.add(target);
			socket.on("error", () => target.destroy());
			target.on("error", () => socket.destroy());
		});
	}
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address() as { port: number };
		// Git and the helper must both use the workspace's proxy; broker.test cannot resolve.
		Object.assign(env, { http_proxy: `http://127.0.0.1:${address.port}`, HTTP_PROXY: `http://127.0.0.1:${address.port}`, https_proxy: `http://127.0.0.1:${address.port}`, HTTPS_PROXY: `http://127.0.0.1:${address.port}`, NO_PROXY: "", no_proxy: "" });
		const url = tlsServer ? `https://broker.test:${(tlsServer.address() as { port: number }).port}/demo.git` : "http://broker.test/demo.git";
		await writeFile(join(home, "helper.mjs"), workspaceCredentialHelper);
		await writeFile(join(home, "credential.json"), JSON.stringify({ url, token }), { mode: 0o600 });
		await git(root, "config", "--global", `credential.${url}.useHttpPath`, "true");
		await git(root, "config", "--global", `credential.${url}.helper`, `!node ${join(home, "helper.mjs")}`);
		await git(root, "clone", url, "checkout");
		const checkout = join(root, "checkout");
		await git(source, "checkout", "-b", "topic");
		await writeFile(join(source, "b.txt"), "new branch");
		await git(source, "add", ".");
		await git(source, "commit", "-m", "Topic");
		await git(source, "push", bare, "topic");
		const fetched = await git(checkout, "fetch", "origin", "topic");
		expect(fetched.stderr).not.toContain("pimgit_");
		await git(source, "checkout", "main");
		await writeFile(join(source, "a.txt"), "second");
		await git(source, "commit", "-am", "Update");
		await git(source, "push", bare, "main");
		await git(checkout, "pull", "--ff-only", "origin", "main");
		expect(await readFile(join(checkout, "a.txt"), "utf8")).toBe("second");
		expect(renewals).toBeGreaterThanOrEqual(3);
		expect(JSON.stringify(env)).not.toContain("pimgit_");
		expect(await readFile(join(checkout, ".git/config"), "utf8")).not.toContain("pimgit_");
		expect(await readFile(join(home, ".gitconfig"), "utf8")).not.toContain("pimgit_");
		await expect(git(checkout, "push", "origin", "main")).rejects.toThrow();
		expect(requests.some(path => path.includes("git-receive-pack"))).toBe(true);
		expired = true;
		const failure = await git(checkout, "fetch", "origin", "main").catch(error => error);
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).not.toContain("pimgit_");
	} finally {
		for (const socket of tunnels) socket.destroy();
		if (tlsServer) {
			tlsServer.closeAllConnections();
			await new Promise<void>(resolve => tlsServer!.close(() => resolve()));
		}
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
});
