#!/usr/bin/env node
// Makes a one-use launch evaluator credential for the preview's Cua evaluation (docs/launch-evaluator.md).
//
//   node scripts/preview-launch-evaluator-grant.mjs <evaluator file> <origin> <viewer origin> <owner> <evaluation> <deployment> <existing unconfirmed ID | none> <notAfter>
//
// Writes the evaluator's input, with a fresh credential, to <evaluator file>, which must not exist yet,
// readable by its owner only. Prints the grant for PREVIEW_LAUNCH_EVALUATOR_GRANT, which holds only the
// credential's SHA-256. The credential is never printed, logged or put in a URL, and is not the automation
// grant's: make each with its own script. The grant runs once; a second run needs a new grant.
// <existing unconfirmed ID> names the one earlier record the operator found `unconfirmed`, which the
// isolated preview's exception lets the evaluator's fresh observation start beside; `none` names none.
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const [file, origin, viewerOrigin, owner, evaluation, deployment, existing, notAfter] = process.argv.slice(2);
const exactHttps = (value) => typeof value === "string" && URL.canParse(value) && new URL(value).protocol === "https:" && new URL(value).origin === value;
const problems = [
	[typeof file === "string" && isAbsolute(file), "the evaluator file must be an absolute path"],
	[exactHttps(origin), "the origin must be Pim's exact https:// address"],
	[exactHttps(viewerOrigin) && exactHttps(origin) && new URL(viewerOrigin).hostname !== new URL(origin).hostname, "the viewer origin must be the bridge's exact https:// address, on another host than Pim's"],
	[/^o_[0-9a-z]{26}$/.test(owner ?? ""), "the owner must be an owner ID"],
	[/^[a-z0-9][a-z0-9-]{2,62}$/.test(evaluation ?? ""), "the evaluation ID must be 3 to 63 lowercase letters, digits and hyphens"],
	[/^cua-eval@(celld|cloudflare)$/.test(deployment ?? ""), "the deployment must be cua-eval@celld or cua-eval@cloudflare"],
	[existing === "none" || /^[A-Za-z0-9_-]{16,64}$/.test(existing ?? ""), "the existing unconfirmed record must be an observation ID, or none"],
	[
		/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/.test(notAfter ?? "") && Date.parse(notAfter) > Date.now() && Date.parse(notAfter) <= Date.now() + 24 * 60 * 60 * 1000,
		"notAfter must be a UTC time within the next 24 hours, such as 2026-10-29T12:00:00Z",
	],
].filter(([ok]) => !ok);
if (problems.length > 0) {
	for (const [, problem] of problems) console.error(problem);
	process.exit(2);
}

const credential = randomBytes(32).toString("base64url");
// `wx`: never over or through anything already there.
writeFileSync(file, `${JSON.stringify({ version: 1, kind: "launch-evaluator", origin, viewerOrigin, owner, evaluation, deployment, credential })}\n`, { flag: "wx", mode: 0o600 });
const credentialSha256 = createHash("sha256").update(credential).digest("hex");
const existingUnconfirmed = existing === "none" ? null : existing;
console.log(JSON.stringify({ kind: "launch-evaluator", owner, evaluation, deployment, origin, credentialSha256, notAfter, existingUnconfirmed }));
