/** A browser's part: a cookie jar over fetch, and the ingress secret the proxy would add to every request. */
export class Client {
	readonly jar = new Map<string, string>();
	constructor(
		readonly base: string,
		readonly ingress: string,
	) {}
	get cookie() {
		return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
	}
	async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: any }> {
		const res = await fetch(this.base + path, {
			method,
			redirect: "manual",
			headers: { "x-pim-ingress-secret": this.ingress, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(this.jar.size ? { cookie: this.cookie } : {}), ...extra },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		for (const line of res.headers.getSetCookie()) {
			const [pair = "", ...attrs] = line.split("; ");
			const [name = "", ...v] = pair.split("=");
			if (attrs.includes("Max-Age=0")) this.jar.delete(name);
			else this.jar.set(name, v.join("="));
		}
		const text = await res.text();
		return { status: res.status, json: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
	}
}
