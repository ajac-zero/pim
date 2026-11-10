// Fails when the repository names a deployment's internal hosts or identifiers.
// Those are set as Worker variables, never committed; docs and tests use example domains.
// The banned words are kept only as SHA-256 hashes, so this file names none of them.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const SELF = "scripts/check-internal-identifiers.mjs";
const bannedHashes = new Set([
	"700438b7e0a7cbec63de3df4a2c855c78b1ce432ac14b4a01c2e910e334d3d7d",
	"a6c8ff1b2a1a9e2816e61d52381bb1bbddd39bb55317199261b581264d949c73",
	"d172a96c707b6b130b3174498ba041ec2b8dc744a389f3a97ba33514fb4f6568",
	"93676a69cbce5812754ee04fde24e029b090e992a6776f90477f7abf68575487",
]);
const exampleGitea = /^gitea\.example\.(com|test)(\.|$)|^gitea\.invalid$/;
const sha = (s) => createHash("sha256").update(s).digest("hex");

/** Words, dot-separated labels and hyphen-joined runs of a text, lowercased, to compare by hash. */
function* candidates(text) {
	for (const m of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9._-]*/g)) {
		const word = m[0];
		yield word;
		const labels = word.split(".").filter(Boolean);
		for (const label of labels) {
			yield label;
			const parts = label.split(/[-_]/).filter(Boolean);
			for (let i = 0; i < parts.length; i++) for (let j = i + 1; j <= parts.length; j++) yield parts.slice(i, j).join("-");
		}
	}
}

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const problems = [];
for (const file of files) {
	if (file === SELF) continue;
	let text;
	try {
		text = execFileSync("git", ["show", `:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	} catch {
		continue;
	}
	for (const c of new Set(candidates(text))) if (bannedHashes.has(sha(c))) problems.push(`${file}: contains a banned identifier (hash ${sha(c).slice(0, 8)})`);
	for (const m of text.matchAll(/https?:\/\/(gitea[\w.-]*)/gi)) {
		const host = m[1].toLowerCase().replace(/\.+$/, "");
		if (!exampleGitea.test(host)) problems.push(`${file}: non-example Gitea host`);
	}
}
if (problems.length) {
	console.error(`Internal identifiers found:\n${problems.join("\n")}`);
	process.exit(1);
}
console.log(`No internal identifiers in ${files.length} files.`);
