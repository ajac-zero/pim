// The bucket operations run-scratch.sh needs, against its disposable moto S3 server only, signed
// with moto's made-up credentials. Never point this at a real bucket.
//
//   node scratch-bucket.mjs create BUCKET
//   node scratch-bucket.mjs find BUCKET PREFIX NEEDLE...   keys whose object holds any NEEDLE
//   node scratch-bucket.mjs copy BUCKET PREFIX TO_BUCKET TO_PREFIX
//                                     server-side copies, which keep each object's metadata
//
// S3_ENDPOINT is the server.

import { createHash, createHmac } from "node:crypto";

const endpoint = process.env.S3_ENDPOINT;
const REGION = "us-east-1";

/** fetch, signed with AWS Signature Version 4 for the scratch credentials. */
function s3(url, { method = "GET", headers = {} } = {}) {
	const target = new URL(url);
	const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
	const day = now.slice(0, 8);
	const signed = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), host: target.host, "x-amz-content-sha256": "UNSIGNED-PAYLOAD", "x-amz-date": now };
	const names = Object.keys(signed).sort();
	const query = [...target.searchParams].map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)]).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
	const canonical = [method, target.pathname, query, ...names.map((n) => `${n}:${signed[n]}`), "", names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
	const scope = `${day}/${REGION}/s3/aws4_request`;
	const toSign = ["AWS4-HMAC-SHA256", now, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
	const key = ["aws4_request", "s3", REGION, day].reduceRight((k, part) => createHmac("sha256", k).update(part).digest(), "AWS4scratch");
	const signature = createHmac("sha256", key).update(toSign).digest("hex");
	return fetch(url, { method, headers: { ...signed, authorization: `AWS4-HMAC-SHA256 Credential=scratch/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` } });
}
// A key as a URL path; celld's keys hold `:` and `%`, which must reach the store as they are.
const encodeKey = (key) => key.split("/").map((segment) => encodeURIComponent(segment).replace(/%3A/g, ":").replace(/%24/g, "$")).join("/");
const path = (bucket, key = "") => `${endpoint}/${bucket}/${encodeKey(key)}`;
const unescape = (xml) => xml.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

async function ok(response, what) {
	if (!response.ok) throw new Error(`${what}: ${response.status} ${await response.text()}`);
	return response;
}

async function* keys(bucket, prefix) {
	let token = "";
	do {
		const query = new URLSearchParams({ "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) });
		const xml = await (await ok(await s3(`${endpoint}/${bucket}?${query}`), `list ${bucket}`)).text();
		for (const [, key] of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) yield unescape(key);
		token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unescape(/<NextContinuationToken>([^<]*)</.exec(xml)[1]) : "";
	} while (token);
}

const [command, ...args] = process.argv.slice(2);
if (command === "create") {
	await ok(await s3(path(args[0]), { method: "PUT" }), `create ${args[0]}`);
} else if (command === "find") {
	const [bucket, prefix, ...needles] = args;
	let objects = 0;
	for await (const key of keys(bucket, prefix)) {
		objects++;
		const body = Buffer.from(await (await ok(await s3(path(bucket, key)), `get ${key}`)).arrayBuffer());
		const found = needles.filter((needle) => body.includes(needle));
		if (found.length) console.log(`${key}\t${found.length}/${needles.length}`);
	}
	console.error(`searched ${objects} objects`);
} else if (command === "copy") {
	const [bucket, prefix, toBucket, toPrefix] = args;
	let copied = 0;
	for await (const key of keys(bucket, prefix)) {
		const source = `/${bucket}/${encodeKey(key)}`;
		await ok(await s3(path(toBucket, toPrefix + key.slice(prefix.length)), { method: "PUT", headers: { "x-amz-copy-source": source } }), `copy ${key}`);
		copied++;
	}
	console.error(`copied ${copied} objects`);
} else {
	throw new Error("usage: scratch-bucket.mjs create|find|copy ...");
}
