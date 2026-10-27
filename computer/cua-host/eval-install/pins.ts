/**
 * What the viewer-first startup downloads, pinned (docs/cua-viewer-first-startup.md, "Delivery"): each
 * artifact's exact HTTPS address, its SHA-256 (or, for an npm package, its SHA-512 integrity), and a size
 * bound, so `fetch.sh` refuses anything else before it unpacks a byte. The values were read from each
 * publisher's own record on the date in the docs; none has been downloaded or run here.
 *
 * The commit whose archive is the bundle's source (B) and that archive's SHA-256 are pinned too; `missingPins` names any that is empty,
 * and the render refuses while one is, and refuses a configuration whose `commit` is not B. The digests of the
 * extracted programs are the configuration's (`node.sha256`, `browser.sha256`, `viewer.caddy.sha256`),
 * which the operator records from a trusted unpack; `fetch.sh` checks the unpacked program against them.
 */

import { Refusal } from "./config.ts";

export type Archive = { readonly url: string; readonly sha256: string; readonly maxBytes: number };

export type Pins = {
	/** Node's release archive; `version` is the configuration's `node.version`. */
	readonly node: Archive & { readonly version: string };
	/** Caddy's release archive; `version` is the configuration's `viewer.caddy.version`. */
	readonly caddy: Archive & { readonly version: string };
	/** spacesd's binary itself, so its SHA-256 is the configuration's `viewer.spacesd.sha256`; `bytes` is its exact size. */
	readonly spacesd: Archive & { readonly version: string; readonly bytes: number };
	/** Google's Chrome package (`.deb`); `version` is Google's package version. */
	readonly chrome: Archive & { readonly version: string; readonly bytes: number };
	/** The GitHub archive of the repository at `commit`, which the render checks is the configuration's. Null until pinned. */
	readonly repository: { readonly commit: string | null; readonly sha256: string | null; readonly maxBytes: number };
	/** The two npm packages the bundle carries, by SHA-512 integrity as pnpm-lock.yaml records it (the bundle build checks them against the lockfile too). */
	readonly ws: { readonly url: string; readonly sha512: string; readonly maxBytes: number };
	readonly protobuf: { readonly url: string; readonly sha512: string; readonly maxBytes: number };
};

export const PINS: Pins = {
	node: {
		version: "v22.18.0",
		url: "https://nodejs.org/dist/v22.18.0/node-v22.18.0-linux-x64.tar.gz",
		sha256: "a2e703725d8683be86bb5da967bf8272f4518bdaf10f21389e2b2c9eaeae8c8a",
		maxBytes: 96 * 1024 * 1024,
	},
	caddy: {
		version: "v2.11.7",
		url: "https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_linux_amd64.tar.gz",
		sha256: "727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b",
		maxBytes: 48 * 1024 * 1024,
	},
	spacesd: {
		version: "0.7.0",
		url: "https://github.com/trycua/cua/releases/download/cua-spacesd-v0.7.0/cua-spacesd-x86_64-unknown-linux-gnu",
		sha256: "78622428711f3778127ad661ba2976ae27bf23ae5e05439d60d5b95511c808fd",
		bytes: 121_121_848,
		maxBytes: 121_121_848,
	},
	chrome: {
		version: "156.0.8078.47-1",
		url: "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_156.0.8078.47-1_amd64.deb",
		sha256: "6c92cd22e90c6e3e255d782991543fa2091db8614e8536a971a7433a5c4d7ac8",
		bytes: 144_849_192,
		maxBytes: 144_849_192,
	},
	// B, the bundle-source commit (docs/cua-viewer-first-startup.md, "The bundle-source candidate"): the archive GitHub's codeload serves for it, 2,693,038 bytes, taken on two machines.
	repository: { commit: "afc9371a75f1c21b3b22627222b9791ef283692d", sha256: "582716ed2cac76e546980d0e856160e45e6b5f64e2dfde0aa2b2173b3236aae8", maxBytes: 64 * 1024 * 1024 },
	ws: {
		url: "https://registry.npmjs.org/ws/-/ws-8.22.0.tgz",
		sha512: "Ydggc987+RO0AnWtZ/7Wq9FtNvcrL1b/RO0ud9mWjUPgDrsAAwQSF51sm2hm1XofbU/4jkpGEsLFsZZxU+1DOg==",
		maxBytes: 1024 * 1024,
	},
	protobuf: {
		url: "https://registry.npmjs.org/@bufbuild/protobuf/-/protobuf-2.15.0.tgz",
		sha512: "DAheWUkVr/SJTWCc+lg9dhY0eN4SaWlf4+bG1KzHeXbnqt0AfB/NX0Z+VunGlM1ki1B4zVvye27MpKh/svySUA==",
		maxBytes: 4 * 1024 * 1024,
	},
};

/** The names of the pins still empty; the render refuses while any is. */
export function missingPins(pins: Pins): string[] {
	return [...(pins.repository.commit === null ? ["repository-commit"] : []), ...(pins.repository.sha256 === null ? ["repository-sha256"] : [])];
}

/** An npm integrity (`sha512-<base64>`'s base64) as the lowercase hex `sha512sum` prints. */
export function integrityHex(integrity: string): string {
	const bytes = Buffer.from(integrity, "base64");
	if (bytes.length !== 64) throw new Refusal("pin-integrity");
	return bytes.toString("hex");
}
