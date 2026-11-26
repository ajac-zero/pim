// The registry operations the publish workflow does, behind one small interface so the promotion scripts (edge-promote.mjs, release-promote.mjs) can be tested against a fake registry.
// A `run(args)` function executes `docker <args>` and returns its stdout, throwing when it fails; `dockerRun` is the real one.
import { execFileSync } from "node:child_process";

export const dockerRun = (args, input) => execFileSync("docker", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });

/** The images of a release, by repository name; each is published under `ghcr.io/<owner>/<name>`. */
export const IMAGE_NAMES = ["pim", "pim-web", "pim-computer"];

export function registry(run = dockerRun) {
	const inspect = (ref) => JSON.parse(run(["buildx", "imagetools", "inspect", ref, "--format", "{{ json . }}"]));
	/** The digest `ref` points at, or null when there is no such tag. */
	const digest = (ref) => {
		try {
			return inspect(ref).manifest?.digest ?? null;
		} catch {
			return null;
		}
	};
	/** A label of the image `ref` (any platform's, the first found), or null. */
	const label = (ref, name) => {
		try {
			const found = JSON.stringify(inspect(ref).image ?? {});
			const match = new RegExp(`"${name.replace(/[.]/g, "\\.")}":"([^"]*)"`).exec(found);
			return match ? match[1] : null;
		} catch {
			return null;
		}
	};
	return {
		digest,
		exists: (ref) => digest(ref) !== null,
		label,
		/** Points every tag at the image `from` names: the same manifest, digest and labels, nothing built. */
		tag: (from, ...tags) => void run(["buildx", "imagetools", "create", ...tags.flatMap((t) => ["--tag", t]), from]),
		/** Pushes `ref` as an empty image carrying one label: a record in the registry (the commit that promoted `edge`, a rollback), written and read like any tag. */
		writeRecord: (ref, name, value) => void run(["buildx", "build", "--provenance=false", "--push", "-t", ref, "-f", "-", "."], `FROM scratch\nLABEL ${name}=${value}\n`),
	};
}
