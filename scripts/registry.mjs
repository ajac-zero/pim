// The registry operations the publish workflow does, behind one small interface so the promotion scripts (edge-promote.mjs, release-promote.mjs) can be tested. A `run(args, input)` function executes
// `docker <args>` and returns stdout, throwing an error with `stderr` when it fails; `dockerRun` is the real one. The adapter is checked against a real buildx and a real registry in CI
// (scripts/registry.integration.test.ts), not only against a fake.
//
// `docker buildx imagetools inspect <ref> --format '{{ json . }}'` prints `{ "name", "manifest", "image" }`: `manifest` is the manifest or index (its `digest` is what a tag points at), and `image` is
// the image config of a single-platform image, or an object of them by platform (`"linux/amd64": {...}`) for an index; labels are `config.Labels` of a config.
import { execFileSync } from "node:child_process";

export const dockerRun = (args, input) => {
	try {
		return execFileSync("docker", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
	} catch (error) {
		const stderr = error?.stderr?.toString?.() ?? "";
		throw Object.assign(new Error(`docker ${args.slice(0, 3).join(" ")} failed: ${stderr.trim() || error?.message}`), { stderr });
	}
};

/** The images of a release, by repository name; each is published under `<host>/<owner>/<name>`. */
export const IMAGE_NAMES = ["pim", "pim-web", "pim-computer"];

/** A registry that could not be read or written (an outage, a refused login, an answer that is not understood): never to be taken for "there is no such image". */
export class RegistryError extends Error {}

// What a registry says when the tag, or the repository, is not there. Anything else (a refused connection, a 401 or 403, a timeout, a 5xx) is an error.
const NOT_FOUND = /not found|MANIFEST_UNKNOWN|NAME_UNKNOWN|no such manifest/i;

export function registry(run = dockerRun) {
	/** The inspected image, or null when it does not exist; throws a RegistryError for anything else. */
	const inspect = (ref) => {
		let out;
		try {
			out = run(["buildx", "imagetools", "inspect", ref, "--format", "{{ json . }}"]);
		} catch (error) {
			const message = `${error?.stderr ?? ""} ${error?.message ?? ""}`;
			if (NOT_FOUND.test(message)) return null;
			throw new RegistryError(`could not inspect ${ref}: ${message.trim()}`);
		}
		let parsed;
		try {
			parsed = JSON.parse(out);
		} catch {
			throw new RegistryError(`could not read what the registry said about ${ref}`);
		}
		if (!parsed?.manifest?.digest) throw new RegistryError(`${ref}: the answer has no manifest digest`);
		return parsed;
	};
	/** The configs of an inspected image: one for a single-platform image, one per platform for an index. */
	const configs = (image) => {
		if (!image) return [];
		if (image.config || image.architecture) return [image];
		return Object.values(image).filter((c) => c && typeof c === "object");
	};
	return {
		/** The digest `ref` points at, or null when there is no such tag. */
		digest: (ref) => inspect(ref)?.manifest.digest ?? null,
		exists: (ref) => inspect(ref) !== null,
		/** A label of the image `ref`, from the first platform that has it; null when the image or the label is not there. */
		label: (ref, name) => {
			for (const config of configs(inspect(ref)?.image)) {
				const value = config.config?.Labels?.[name];
				if (typeof value === "string") return value;
			}
			return null;
		},
		/** Points every tag at the image `from` names: the same manifest, digest and labels, nothing built. */
		tag: (from, ...tags) => void run(["buildx", "imagetools", "create", ...tags.flatMap((t) => ["--tag", t]), from]),
		/** Pushes `ref` as an empty image carrying one label: a record in the registry (the commit that promoted `edge`, a rollback), written and read like any tag. */
		writeRecord: (ref, name, value) => void run(["buildx", "build", "--provenance=false", "--push", "-t", ref, "-f", "-", "."], `FROM scratch\nLABEL ${name}=${value}\n`),
	};
}
