#!/usr/bin/env node
// Makes an automation credential for the preview's Cua evaluation (docs/preview-automation.md).
//
//   node scripts/preview-automation-grant.mjs <runner file> <origin> <owner> <evaluation> <deployment> <notAfter>
//
// Writes the runner's input, with the credential, to <runner file>, which must not exist yet, readable
// by its owner only. Prints the grant for PREVIEW_AUTOMATION_GRANT, which holds only the credential's
// SHA-256. The credential is never printed, logged or put in a URL.
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const [file, origin, owner, evaluation, deployment, notAfter] = process.argv.slice(2);
const problems = [
	[typeof file === "string" && isAbsolute(file), "the runner file must be an absolute path"],
	[typeof origin === "string" && URL.canParse(origin) && new URL(origin).protocol === "https:" && new URL(origin).origin === origin, "the origin must be Pim's exact https:// address"],
	[/^o_[0-9a-z]{26}$/.test(owner ?? ""), "the owner must be an owner ID"],
	[/^[a-z0-9][a-z0-9-]{2,62}$/.test(evaluation ?? ""), "the evaluation ID must be 3 to 63 lowercase letters, digits and hyphens"],
	[/^cua-eval@(celld|cloudflare)$/.test(deployment ?? ""), "the deployment must be cua-eval@celld or cua-eval@cloudflare"],
	[/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(notAfter ?? "") && Date.parse(notAfter) > Date.now(), "notAfter must be a future UTC time, such as 2026-10-30T01:20:50Z"],
].filter(([ok]) => !ok);
if (problems.length > 0) {
	for (const [, problem] of problems) console.error(problem);
	process.exit(2);
}

const credential = randomBytes(32).toString("base64url");
// `wx`: never over or through anything already there.
writeFileSync(file, `${JSON.stringify({ version: 1, origin, owner, evaluation, deployment, credential })}\n`, { flag: "wx", mode: 0o600 });
const credentialSha256 = createHash("sha256").update(credential).digest("hex");
console.log(JSON.stringify({ owner, evaluation, deployment, origin, credentialSha256, notAfter }));
