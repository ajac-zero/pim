import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { natsBinary, runBenchmark } from "../src/bench/orchestrator.ts";
import { PROFILES } from "../src/bench/profiles.ts";

const hasNats = (() => {
	try {
		return existsSync(natsBinary());
	} catch {
		return false;
	}
})();

describe.skipIf(!hasNats)("the load benchmark harness (real PostgreSQL, real NATS, separate Runner, Gate, Live and browser processes)", () => {
	it("runs the 5-run profile end to end and reports measured, internally consistent numbers", async () => {
		const result = await runBenchmark({ profile: PROFILES["5"]!, phases: { baselineSeconds: 2, rampSeconds: 3, loadedSeconds: 5 }, workload: { ttftMs: 100, tokensPerTurn: 40, toolLatencyMs: 100, errorRate: 0 } });
		expect(result.activeStreamingRuns).toBe(5);
		expect(result.idleStoredChats).toBeGreaterThan(result.activeStreamingRuns * 10);
		expect(result.write.fencingRejects).toBe(0);
		expect(result.write.commitsPerSecondInWindow!).toBeGreaterThan(5);
		expect(result.write.providerErrors).toBe(0);
		expect(result.foreground.baseline.sidebar!.n).toBeGreaterThan(50);
		expect(result.foreground.underLoad.sidebar!.n).toBeGreaterThan(50);
		expect(result.foreground.underLoad.errors).toBe(0);
		expect(result.live.websocketsOpen).toBe(result.live.websocketsRequested);
		expect(result.live.eventsReceived).toBeGreaterThan(0);
		expect(result.environment.settings).toMatchObject({ fsync: "on", synchronous_commit: "on", full_page_writes: "on" });
		// Commits written by Runners are rows in the database: nothing was lost on the way.
		expect(Number(result.dataRows.entries)).toBeGreaterThan(result.idleStoredEntries);
		expect(Number(result.dataRows.flood)).toBeGreaterThan(0);
	});
});
