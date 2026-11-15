import { describe, expect, it, vi } from "vitest";
import { ampAttachments, fetchAmpImage, replaceAmpAttachments } from "../src/orb/amp-attachments";

const BASE = "https://ampcode.com";
const LIGHT = `${BASE}/user-content/attachments/9fbe-cuda-cpp-light.png#amp-media-source=file%3A%2F%2F%2Fa.png&amp-media-width=2560&amp-media-height=1200&amp-media-preview=abc`;
const DARK = `${BASE}/user-content/attachments/bfb0-cuda-cpp-dark.png#amp-media-width=2560`;
const OPTIONS = { token: "sgamp_secret", types: ["image/png", "image/jpeg"], maxBytes: 100 };

describe("finding Amp attachment images", () => {
	it("finds each attachment image outside code, with its fragment kept and its fetch address without", () => {
		const text = `![Light](${LIGHT})\n![Dark](${DARK}) ![again](${DARK})`;
		expect(ampAttachments(text)).toEqual([
			{ url: LIGHT, canonical: `${BASE}/user-content/attachments/9fbe-cuda-cpp-light.png` },
			{ url: DARK, canonical: `${BASE}/user-content/attachments/bfb0-cuda-cpp-dark.png` },
		]);
	});

	it("takes Amp's other attachment paths and no other origin or path", () => {
		const uuid = "3f1beb2b-bded-4fda-96cc-1af7192f24b6";
		const ok = [`${BASE}/attachments/a.png`, `${BASE}/user-content/temporary-files/a.png`, `${BASE}/user-content/artifacts/a`, `${BASE}/user-content/artifact-files/${uuid}/a.png`];
		const no = [`https://evil.example/user-content/attachments/a.png`, `http://ampcode.com/attachments/a.png`, `${BASE}/user-content/attachments/a/b.png`, `${BASE}/api/internal`, `${BASE}/user-content/artifact-files/x/a.png`, `https://ampcode.com.evil.example/attachments/a.png`];
		expect(ampAttachments([...ok, ...no].map((url) => `![x](${url})`).join("\n")).map((a) => a.url)).toEqual(ok);
	});

	it("ignores images in fenced code and inline code, and links that are not images", () => {
		const text = ["```md", `![f](${LIGHT})`, "```", `\`![i](${LIGHT})\``, `[link](${LIGHT})`, `~~~\n![t](${DARK})\n~~~`].join("\n");
		expect(ampAttachments(text)).toEqual([]);
	});

	it("replaces the whole address with its copy, outside code only", () => {
		const text = `![Light](${LIGHT}) and \`![Light](${LIGHT})\``;
		expect(replaceAmpAttachments(text, new Map([[LIGHT, "/api/images/abc"]]))).toBe("![Light](/api/images/abc) and `![Light](" + LIGHT + ")`");
	});
});

describe("fetching an Amp attachment", () => {
	const png = (body = new Uint8Array([1, 2, 3]), headers: Record<string, string> = {}) => new Response(body, { headers: { "content-type": "image/png", ...headers } });
	const canonical = `${BASE}/user-content/attachments/a.png`;
	const headersOf = (fetcher: { mock: { calls: unknown[][] } }, call: number) => (fetcher.mock.calls[call]![1] as RequestInit).headers as Record<string, string>;

	it("sends the Amp login to Amp, without following redirects by itself", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => png());
		const result = await fetchAmpImage(canonical, { ...OPTIONS, fetch: fetcher });
		expect(result).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3]), type: "image/png" });
		expect(headersOf(fetcher, 0).authorization).toBe("Bearer sgamp_secret");
		expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
	});

	it("follows a redirect to Amp's own origin with the login, and one to other HTTPS storage without it", async () => {
		const same = vi.fn<typeof fetch>(async (url) => (String(url).endsWith("a.png") ? new Response(null, { status: 302, headers: { location: "/attachments/b.png" } }) : png()));
		expect((await fetchAmpImage(canonical, { ...OPTIONS, fetch: same })).ok).toBe(true);
		expect(headersOf(same, 1).authorization).toBe("Bearer sgamp_secret");

		const away = vi.fn<typeof fetch>(async (url) => (String(url).startsWith(BASE) ? new Response(null, { status: 307, headers: { location: "https://storage.example/obj?sig=1" } }) : png()));
		expect((await fetchAmpImage(canonical, { ...OPTIONS, fetch: away })).ok).toBe(true);
		expect(String(away.mock.calls[1]![0])).toBe("https://storage.example/obj?sig=1");
		expect(headersOf(away, 1).authorization).toBeUndefined();
	});

	it("refuses redirects to plain HTTP and to private addresses, and a second hop, without asking them", async () => {
		for (const location of ["http://storage.example/a.png", "https://localhost/a.png", "https://169.254.169.254/latest", "https://10.0.0.5/a.png", "https://[::1]/a.png", "https://db.internal/a.png"]) {
			const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
			expect(await fetchAmpImage(canonical, { ...OPTIONS, fetch: fetcher })).toEqual({ ok: false, retry: false });
			expect(fetcher).toHaveBeenCalledTimes(1);
		}
		const twice = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://storage.example/x" } }));
		expect(await fetchAmpImage(canonical, { ...OPTIONS, fetch: twice })).toEqual({ ok: false, retry: false });
		expect(twice).toHaveBeenCalledTimes(2);
	});

	it("takes only the allowed image types within the size limit, counted as the body arrives", async () => {
		const svg = new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } });
		expect(await fetchAmpImage(canonical, { ...OPTIONS, fetch: async () => svg })).toEqual({ ok: false, retry: false });
		expect(await fetchAmpImage(canonical, { ...OPTIONS, fetch: async () => png(new Uint8Array(100)) })).toMatchObject({ ok: true });
		// A body over the limit with no Content-Length to say so.
		expect(await fetchAmpImage(canonical, { ...OPTIONS, fetch: async () => png(new Uint8Array(101)) })).toEqual({ ok: false, retry: false });
		expect(await fetchAmpImage(canonical, { ...OPTIONS, fetch: async () => png(new Uint8Array(1), { "content-length": "101" }) })).toEqual({ ok: false, retry: false });
		expect(await fetchAmpImage(canonical, { ...OPTIONS, fetch: async () => png(new Uint8Array(0)) })).toEqual({ ok: false, retry: false });
	});

	it("says which failures are worth another try", async () => {
		const status = (code: number) => fetchAmpImage(canonical, { ...OPTIONS, fetch: async () => new Response("x", { status: code }) });
		expect(await status(404)).toEqual({ ok: false, retry: false });
		expect(await status(401)).toEqual({ ok: false, retry: true });
		expect(await status(503)).toEqual({ ok: false, retry: true });
		expect(await fetchAmpImage(canonical, { ...OPTIONS, fetch: async () => { throw new Error("down"); } })).toEqual({ ok: false, retry: true });
	});
});
