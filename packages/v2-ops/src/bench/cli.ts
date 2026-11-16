import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runBenchmark } from "./orchestrator.ts";
import { PROFILES } from "./profiles.ts";

const { values } = parseArgs({
	options: {
		profile: { type: "string", multiple: true, default: ["5"] },
		out: { type: "string", default: "packages/v2-ops/bench-results" },
		mode: { type: "string", default: "single" },
		"loaded-seconds": { type: "string", default: "20" },
		"baseline-seconds": { type: "string", default: "8" },
		"ramp-seconds": { type: "string", default: "6" },
		"turn-pause-ms": { type: "string" },
		label: { type: "string", default: "" },
	},
});

await mkdir(values.out!, { recursive: true });
let code = 0;
for (const name of values.profile!) {
	const profile = PROFILES[name];
	if (!profile) throw new Error(`Unknown profile ${name}; choose ${Object.keys(PROFILES).join(", ")}`);
	console.log(`--- profile ${name}: ${profile.activeRuns} active streaming runs, ${profile.tenants} tenants, commit mode ${values.mode}`);
	try {
		const result = await runBenchmark({ profile, workload: { commitMode: values.mode as "single" | "batched", ...(values["turn-pause-ms"] ? { turnPauseMs: Number(values["turn-pause-ms"]) } : {}) }, phases: { loadedSeconds: Number(values["loaded-seconds"]), baselineSeconds: Number(values["baseline-seconds"]), rampSeconds: Number(values["ramp-seconds"]) }, log: console.log });
		const file = join(values.out!, `${new Date().toISOString().slice(0, 10)}-${name}-${values.mode}${values.label ? `-${values.label}` : ""}.json`);
		await writeFile(file, JSON.stringify(result, null, 2));
		console.log(JSON.stringify({ foreground: result.foreground, write: { commitsPerSecondInWindow: result.write.commitsPerSecondInWindow, commitLatencyMsByRunner: result.write.commitLatencyMsByRunner }, postgres: result.postgres, resources: result.resources, saturation: result.saturation, live: result.live }, null, 2));
		console.log(`wrote ${file}`);
	} catch (error) {
		console.error(`profile ${name} failed:`, error);
		code = 1;
	}
}
process.exit(code);
