// Stand-in for the image endpoints `generate_image` draws on, for a browser run on the Compose stack: an OpenAI-compatible /v1/images/generations (what PIM_IMAGE_MODEL=openai/gpt-image-1
// uses with PIM_OPENAI_BASE_URL pointed here) and ChatGPT's Codex image service with its token endpoint (PIM_CODEX_AUTH_URL, PIM_CODEX_IMAGES_URL). Each draws a real PNG, a different one per
// endpoint and per request, so a screenshot shows which one made it.
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
/** A 320x240 PNG: a gradient from `a` to `b` with a disc of `c` that moves with `n`, so every picture differs. */
function png(a, b, c, n) {
	const w = 320, h = 240, raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++) {
		raw[y * (w * 3 + 1)] = 0;
		for (let x = 0; x < w; x++) {
			const t = (x + y) / (w + h), dx = x - (80 + (n * 47) % 160), dy = y - 120, disc = dx * dx + dy * dy < 50 * 50;
			for (let i = 0; i < 3; i++) raw[y * (w * 3 + 1) + 1 + x * 3 + i] = disc ? c[i] : Math.round(a[i] * (1 - t) + b[i] * t);
		}
	}
	const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const b64u = (v) => Buffer.from(v).toString("base64url");
const token = (seconds) => `${b64u('{"alg":"none"}')}.${b64u(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds, "https://api.openai.com/auth": { chatgpt_account_id: "acct-demo" } }))}.sig`;
let drawn = 0;
createServer(async (req, res) => {
	let body = ""; for await (const c of req) body += c;
	const json = (status, o) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
	console.log(new Date().toISOString(), req.method, req.url, req.headers.authorization ? "(authorized)" : "", body.slice(0, 120));
	if (req.url === "/v1/images/generations") return json(200, { data: [{ b64_json: png([30, 60, 140], [180, 220, 255], [255, 200, 40], ++drawn).toString("base64") }] });
	if (req.url === "/codex/images") return json(200, { data: [{ b64_json: png([120, 20, 90], [255, 190, 150], [40, 220, 160], ++drawn).toString("base64") }] });
	if (req.url === "/oauth/token") return json(200, { access_token: token(/refresh_token/.test(body) ? 3600 : 100), refresh_token: "refresh-" + Date.now(), id_token: `${b64u("{}")}.${b64u(JSON.stringify({ email: "ada@example.com" }))}.sig` });
	json(404, { error: "no such route" });
}).listen(9100, () => console.log("fake images on 9100"));
