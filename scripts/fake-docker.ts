// A stand-in for `docker` that speaks what the registry adapter uses (scripts/registry.mjs), with the JSON shape `docker buildx imagetools inspect --format '{{ json . }}'` prints, and failures
// on demand: a refused connection for every read, or one write that fails. The adapter's behavior against a real buildx and registry is checked by scripts/registry.integration.test.ts.
export class FakeDocker {
	tags = new Map<string, string>();
	images = new Map<string, { labels: Record<string, string>; multi: boolean }>();
	writes = 0;
	/** The nth write (1-based) from now on throws once. */
	failWrite: number | null = null;
	outage = false;
	private counter = 0;

	run = (args: string[], input?: string): string => {
		if (args[0] !== "buildx") throw new Error(`unexpected docker ${args.join(" ")}`);
		if (args[1] === "imagetools" && args[2] === "inspect") return this.inspect(args[3]!);
		this.write();
		if (args[1] === "imagetools" && args[2] === "create") {
			const from = args[args.length - 1]!;
			const digest = this.tags.get(from);
			if (!digest) throw Object.assign(new Error("failed"), { stderr: `${from}: not found` });
			for (let i = 3; i < args.length - 1; i += 2) if (args[i] === "--tag") this.tags.set(args[i + 1]!, digest);
			return "";
		}
		if (args[1] === "build") {
			const ref = args[args.indexOf("-t") + 1]!;
			const labels: Record<string, string> = {};
			for (const m of (input ?? "").matchAll(/^LABEL ([^=\s]+)=(.*)$/gm)) labels[m[1]!] = m[2]!;
			const digest = `sha256:record-${++this.counter}`;
			this.images.set(digest, { labels, multi: false });
			this.tags.set(ref, digest);
			return "";
		}
		throw new Error(`unexpected docker ${args.join(" ")}`);
	};

	private write() {
		this.writes++;
		if (this.failWrite !== null && this.writes === this.failWrite) {
			this.failWrite = null;
			throw Object.assign(new Error("push failed"), { stderr: "error: failed to push: 503 Service Unavailable" });
		}
	}

	private inspect(ref: string): string {
		if (this.outage) throw Object.assign(new Error("failed"), { stderr: `ERROR: failed to do request: Head "https://ghcr.io/v2/x": dial tcp: connect: connection refused` });
		const digest = this.tags.get(ref);
		if (!digest) throw Object.assign(new Error("failed"), { stderr: `ERROR: ${ref}: not found` });
		const image = this.images.get(digest) ?? { labels: {}, multi: true };
		const config = { architecture: "amd64", os: "linux", config: { Labels: image.labels } };
		return JSON.stringify({ name: ref, manifest: { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", digest }, image: image.multi ? { "linux/amd64": config, "linux/arm64": { ...config, architecture: "arm64" } } : config });
	}

	/** A published image: a multi-platform index at `ref`, with labels. */
	publish(ref: string, digest: string, labels: Record<string, string> = {}) {
		this.tags.set(ref, digest);
		this.images.set(digest, { labels, multi: true });
	}
}
