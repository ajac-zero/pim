// The helper holds only a bounded broker grant: it reads the repository, pushes the thread's own branch and asks for its pull request. It never prints diagnostics
// from the broker or puts a credential in an argument or environment variable.
export const WORKSPACE_GIT_AUTH_DIR = "/workspace/.config/pim/git";

export const workspaceCredentialHelper = `import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
const statePath = new URL("./credential.json", import.meta.url);
const mode = process.argv[2];
if (mode !== "get" && mode !== "pull-request") process.exit(0);
// POST to the broker, through the workspace's HTTP proxy when there is one. Node 22 fetch ignores proxy
// variables, so HTTPS is tunneled explicitly and the broker header stays inside TLS.
// Resolves with the body of a 200 answer; rejects with the status and, from a JSON answer, the broker's own error text.
async function post(base, path, token, payload) {
 const target = new URL(base + path);
 const bypass = (process.env.no_proxy ?? process.env.NO_PROXY ?? "").split(",").some(value => {
  const host = value.trim();
  return host === "*" || host === target.hostname || host === target.host ||
   (host.startsWith(".") && target.hostname.endsWith(host));
 });
 const proxyValue = bypass ? "" : target.protocol === "https:"
  ? (process.env.https_proxy ?? process.env.HTTPS_PROXY)
  : (process.env.http_proxy ?? process.env.HTTP_PROXY);
 const proxy = proxyValue ? new URL(proxyValue) : null;
 const signal = AbortSignal.timeout(15000);
 let agent;
 if (proxy && target.protocol === "https:") {
  const socket = await new Promise((resolve, reject) => {
   const connect = (proxy.protocol === "https:" ? https : http).request(proxy, {
    method: "CONNECT", path: target.hostname + ":" + (target.port || "443"), signal
   });
   connect.on("connect", (response, socket, head) => {
    if (response.statusCode !== 200 || head.length) { socket.destroy(); reject(new Error("proxy refused")); }
    else resolve(socket);
   });
   connect.on("error", reject);
   connect.end();
  });
  agent = new https.Agent();
  agent.createConnection = () => tls.connect({ socket, servername: target.hostname });
 }
 const data = payload === undefined ? null : JSON.stringify(payload);
 try {
  return await new Promise((resolve, reject) => {
   const transport = proxy && target.protocol === "http:" ? proxy : target;
   const headers = { Host: target.host, Authorization: "Bearer " + token };
   if (data !== null) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
   const request = (transport.protocol === "https:" ? https : http).request(transport, {
    method: "POST", path: proxy && target.protocol === "http:" ? target.href : target.pathname,
    headers, agent, signal
   }, response => {
    let body = "";
    response.on("data", chunk => {
     body += chunk;
     if (body.length > 16384) request.destroy(new Error("response too large"));
    });
    response.on("error", reject);
    response.on("end", () => {
     if (response.statusCode === 200) return resolve(body);
     let why = "";
     try { if (typeof JSON.parse(body).error === "string") why = JSON.parse(body).error; } catch {}
     reject(Object.assign(new Error("HTTP " + response.statusCode), { why }));
    });
   });
   request.on("error", reject);
   request.end(data ?? undefined);
  });
 } finally {
  agent?.destroy();
 }
}
// A fresh grant of the same repository and scope, saved for the next call. Concurrent helpers may replace one another's equally scoped grants.
async function renew(state) {
 const { token } = JSON.parse(await post(state.url, "/credential", state.token));
 if (typeof token !== "string" || !/^pimgit_[A-Za-z0-9_.-]+$/.test(token)) throw new Error("bad grant");
 const temporary = statePath.pathname + "." + process.pid;
 await fs.writeFile(temporary, JSON.stringify({ url: state.url, token }), { mode: 0o600 });
 await fs.rename(temporary, statePath);
 return token;
}
const state = await fs.readFile(statePath, "utf8").then(JSON.parse, () => null);
if (mode === "get") {
 try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const fields = Object.fromEntries(input.trim().split("\\n").map(line => {
   const at = line.indexOf("=");
   return [line.slice(0, at), line.slice(at + 1)];
  }));
  const url = new URL(state.url);
  if (fields.protocol !== url.protocol.slice(0, -1) || fields.host !== url.host ||
      fields.path !== url.pathname.slice(1)) process.exit(0);
  const token = await renew(state);
  process.stdout.write("username=pim\\npassword=" + token + "\\n\\n");
 } catch {
  // Git reports authentication failure. Never echo a response, token, or exception.
  process.exitCode = 0;
 }
} else {
 // Opens the pull request for this thread's own pushed branch. The broker decides the branch and base; only a title and a description are sent.
 try {
  const args = process.argv.slice(3);
  const payload = {};
  for (let i = 0; i < args.length; i += 2) {
   if ((args[i] !== "--title" && args[i] !== "--body") || typeof args[i + 1] !== "string") throw Object.assign(new Error("usage"), { why: "usage: pull-request [--title TEXT] [--body TEXT]" });
   payload[args[i].slice(2)] = args[i + 1];
  }
  const answer = JSON.parse(await post(state.url, "/pull-request", await renew(state), payload));
  if (typeof answer.url !== "string" || typeof answer.number !== "number") throw new Error("bad answer");
  process.stdout.write(answer.url + "\\n#" + answer.number + "\\n");
 } catch (error) {
  const why = typeof error?.why === "string" ? error.why.replace(/pimgit_[A-Za-z0-9_.-]+/g, "").slice(0, 300) : "";
  // Never echo a token or a raw response: only the broker's short reason, when it gave one.
  process.stderr.write("pull request not opened" + (error?.message?.startsWith("HTTP ") ? " (" + error.message + ")" : "") + (why ? ": " + why : "") + "\\n");
  process.exitCode = 1;
 }
}
`;
