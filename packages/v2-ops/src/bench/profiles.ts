export type Profile = {
	readonly name: string;
	/** Runs streaming at the same time: each is a conversation with a model request in flight. Not the number of stored agents. */
	readonly activeRuns: number;
	readonly tenants: number;
	/** Idle stored conversations per tenant, with history, that no run touches: they make tables and indexes realistic and prove idle data costs no run. */
	readonly idleChatsPerTenant: number;
	readonly runnerProcesses: number;
	/** WebSocket browsers connected while the load runs. */
	readonly browsers: number;
	/** Browsers that never read what they are sent. */
	readonly slowBrowsers: number;
	/** Coding threads writing transcript floods. */
	readonly codingFloods: number;
};

/** The four profiles of the plan. The sandbox sets what is reachable; larger profiles run only when the machine has the cores and memory. */
export const PROFILES: Readonly<Record<string, Profile>> = {
	"5": { name: "5", activeRuns: 5, tenants: 3, idleChatsPerTenant: 100, runnerProcesses: 1, browsers: 6, slowBrowsers: 1, codingFloods: 1 },
	"50": { name: "50", activeRuns: 50, tenants: 10, idleChatsPerTenant: 200, runnerProcesses: 2, browsers: 30, slowBrowsers: 2, codingFloods: 2 },
	"500": { name: "500", activeRuns: 500, tenants: 50, idleChatsPerTenant: 200, runnerProcesses: 4, browsers: 150, slowBrowsers: 5, codingFloods: 5 },
	"1000": { name: "1000", activeRuns: 1000, tenants: 100, idleChatsPerTenant: 200, runnerProcesses: 4, browsers: 300, slowBrowsers: 10, codingFloods: 10 },
};

/** What a simulated model provider does, and how a run behaves: every number here is a parameter, not a claim about a real provider. */
export type Workload = {
	readonly ttftMs: number;
	readonly tokenIntervalMs: number;
	readonly tokensPerTurn: number;
	readonly toolLatencyMs: number;
	/** Pause between a run's turns. 0 keeps it streaming continuously. */
	readonly turnPauseMs: number;
	/** Interval of partial-message commits while streaming (Pim sets 250 ms). */
	readonly partialIntervalMs: number;
	readonly commitMode: "single" | "batched";
	readonly batchWindowMs: number;
	readonly poolSizePerRunner: number;
	readonly errorRate: number;
};

export const DEFAULT_WORKLOAD: Workload = { ttftMs: 400, tokenIntervalMs: 25, tokensPerTurn: 120, toolLatencyMs: 300, turnPauseMs: 200, partialIntervalMs: 250, commitMode: "single", batchWindowMs: 5, poolSizePerRunner: 16, errorRate: 0.01 };

export type PhaseTimes = { readonly baselineSeconds: number; readonly rampSeconds: number; readonly loadedSeconds: number };
export const DEFAULT_PHASES: PhaseTimes = { baselineSeconds: 8, rampSeconds: 6, loadedSeconds: 20 };
