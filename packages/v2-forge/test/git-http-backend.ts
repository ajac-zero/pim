// A git host on a real http server: `git http-backend` (git's own smart-HTTP CGI) over bare repositories.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export class GitHttpHost {
	server!: Server;
	url = "";
	requests: { method: string; path: string; auth: string | null }[] = [];
	constructor(private readonly root: string) {}
	async start() {
		this.server = createServer((req, res) => {
			const u = new URL(req.url!, "http://x");
			this.requests.push({ method: req.method!, path: u.pathname, auth: req.headers.authorization ?? null });
			const env: Record<string, string> = { PATH: process.env.PATH!, GIT_PROJECT_ROOT: this.root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: u.pathname, REQUEST_METHOD: req.method!, QUERY_STRING: u.search.slice(1), CONTENT_TYPE: req.headers["content-type"] ?? "", REMOTE_USER: "pim", REMOTE_ADDR: "127.0.0.1" };
			if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = String(req.headers["content-encoding"]);
			if (req.headers["git-protocol"]) env.HTTP_GIT_PROTOCOL = String(req.headers["git-protocol"]);
			const cgi = spawn("git", ["http-backend"], { env });
			req.pipe(cgi.stdin);
			const chunks: Buffer[] = [];
			cgi.stdout.on("data", (c) => chunks.push(c));
			cgi.on("close", () => {
				const out = Buffer.concat(chunks);
				const split = out.indexOf("\r\n\r\n");
				const head = out.subarray(0, split).toString().split("\r\n");
				let status = 200;
				const headers: Record<string, string> = {};
				for (const line of head) {
					const i = line.indexOf(":");
					const k = line.slice(0, i).toLowerCase();
					const v = line.slice(i + 1).trim();
					if (k === "status") status = Number.parseInt(v, 10);
					else headers[k] = v;
				}
				res.writeHead(status, headers).end(out.subarray(split + 4));
			});
		});
		await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
		this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
		return this;
	}
	stop() {
		this.server.closeAllConnections();
		return new Promise<void>((r) => this.server.close(() => r()));
	}
}
