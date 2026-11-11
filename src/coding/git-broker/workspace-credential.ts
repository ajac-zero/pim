// The helper holds only a bounded, read-only broker grant. It never prints diagnostics
// from the broker or puts a credential in an argument or environment variable.
export const WORKSPACE_GIT_AUTH_DIR = "/workspace/.config/pim/git";

export const workspaceCredentialHelper = `import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
const statePath = new URL("./credential.json", import.meta.url);
try {
 if (process.argv[2] !== "get") process.exit(0);
 let input = "";
 for await (const chunk of process.stdin) input += chunk;
 const fields = Object.fromEntries(input.trim().split("\\n").map(line => {
  const at = line.indexOf("=");
  return [line.slice(0, at), line.slice(at + 1)];
 }));
 const state = JSON.parse(await fs.readFile(statePath, "utf8"));
 const url = new URL(state.url);
 if (fields.protocol !== url.protocol.slice(0, -1) || fields.host !== url.host ||
     fields.path !== url.pathname.slice(1)) process.exit(0);
 // Node 22 fetch ignores proxy variables. Use the workspace's HTTP proxy
 // explicitly, tunneling HTTPS so the broker header stays inside TLS.
 const target = new URL(state.url + "/credential");
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
 const body = await new Promise((resolve, reject) => {
  const transport = proxy && target.protocol === "http:" ? proxy : target;
  const request = (transport.protocol === "https:" ? https : http).request(transport, {
   method: "POST", path: proxy && target.protocol === "http:" ? target.href : target.pathname,
   headers: { Host: target.host, Authorization: "Bearer " + state.token },
   agent, signal
  }, response => {
   let body = "";
   response.on("data", chunk => {
    body += chunk;
    if (body.length > 16384) request.destroy(new Error("response too large"));
   });
   response.on("error", reject);
   response.on("end", () => response.statusCode === 200 ? resolve(body) : reject(new Error("access expired")));
  });
  request.on("error", reject);
  request.end();
 });
 agent?.destroy();
 const { token } = JSON.parse(body);
 if (typeof token !== "string" || !/^pimgit_[A-Za-z0-9_.-]+$/.test(token)) process.exit(0);
 // Concurrent helpers may replace one another's equally scoped grants.
 const temporary = statePath.pathname + "." + process.pid;
 await fs.writeFile(temporary, JSON.stringify({ url: state.url, token }), { mode: 0o600 });
 await fs.rename(temporary, statePath);
 process.stdout.write("username=pim\\npassword=" + token + "\\n\\n");
} catch {
 // Git reports authentication failure. Never echo a response, token, or exception.
 process.exitCode = 0;
}
`;
