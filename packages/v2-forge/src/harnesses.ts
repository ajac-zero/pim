// What each coding harness honestly can and cannot do. The five do not share resume, cost or checkpoint semantics, and callers must read this instead of assuming.

export const HARNESSES = ["pi", "claude-code", "codex", "mistral-vibe", "amp"] as const;
export type Harness = (typeof HARNESSES)[number];

/** A: pi-durable in Forge, tools in the sandbox. B: one vendor CLI process per turn in the sandbox. C: a remote agent-hosted orb. */
export type ExecutionFamily = "sandbox-pi" | "sandbox-cli" | "remote-orb";

export type HarnessCapabilityDescriptor = {
	readonly harness: Harness;
	readonly family: ExecutionFamily;
	/** Needs a sandbox workspace and so a pool slot. Amp never does. */
	readonly needsWorkspace: boolean;
	/** How a stopped turn resumes. */
	readonly resume: "pi-durable-state" | "vendor-session-id" | "remote-thread";
	/** How cost reaches the thread's spend. */
	readonly cost: "per-call" | "usd-delta" | "tokens-only" | "reported-total" | "none";
	/** Whether Forge can stop the model before the budget is crossed, or only notice afterwards. */
	readonly budgetEnforced: boolean;
	/** Whether Forge can checkpoint and autosave the working tree (it can only where it owns a checkout). */
	readonly checkpoints: boolean;
	/** Whether Forge itself can push or merge the branch; Amp pushes with its own credentials. */
	readonly forgePush: boolean;
	/** Where a diff comes from. */
	readonly diff: "workspace" | "remote-git-host";
	/** A running turn can be steered mid-flight. */
	readonly steer: "mid-turn" | "next-turn" | "queued-at-remote";
	/** A running turn that Forge loses (restart, import) is adopted without a restart, or settles as interrupted and resumes. */
	readonly onWorkerRestart: "adopt" | "interrupt-and-resume";
	/** Whether this harness may share the normal agents' runner pool: never. */
	readonly sharesNormalAgentRunners: false;
};

export const CAPABILITIES: Readonly<Record<Harness, HarnessCapabilityDescriptor>> = {
	pi: { harness: "pi", family: "sandbox-pi", needsWorkspace: true, resume: "pi-durable-state", cost: "per-call", budgetEnforced: true, checkpoints: true, forgePush: true, diff: "workspace", steer: "mid-turn", onWorkerRestart: "interrupt-and-resume", sharesNormalAgentRunners: false },
	"claude-code": { harness: "claude-code", family: "sandbox-cli", needsWorkspace: true, resume: "vendor-session-id", cost: "usd-delta", budgetEnforced: true, checkpoints: true, forgePush: true, diff: "workspace", steer: "next-turn", onWorkerRestart: "interrupt-and-resume", sharesNormalAgentRunners: false },
	codex: { harness: "codex", family: "sandbox-cli", needsWorkspace: true, resume: "vendor-session-id", cost: "tokens-only", budgetEnforced: false, checkpoints: true, forgePush: true, diff: "workspace", steer: "next-turn", onWorkerRestart: "interrupt-and-resume", sharesNormalAgentRunners: false },
	"mistral-vibe": { harness: "mistral-vibe", family: "sandbox-cli", needsWorkspace: true, resume: "vendor-session-id", cost: "reported-total", budgetEnforced: true, checkpoints: true, forgePush: true, diff: "workspace", steer: "next-turn", onWorkerRestart: "interrupt-and-resume", sharesNormalAgentRunners: false },
	amp: { harness: "amp", family: "remote-orb", needsWorkspace: false, resume: "remote-thread", cost: "none", budgetEnforced: false, checkpoints: false, forgePush: false, diff: "remote-git-host", steer: "queued-at-remote", onWorkerRestart: "adopt", sharesNormalAgentRunners: false },
};

export const capabilitiesOf = (harness: Harness): HarnessCapabilityDescriptor => CAPABILITIES[harness];

/** The sandbox turn limits the legacy thread kept: how often a lost run auto-resumes, and how often a session may hit its time limit without progress. */
export const MAX_RESUMES = 3;
export const MAX_SESSION_RESTARTS = 3;

/** Rows from before Amp ran in orbs stay readable and say this. */
export const LEGACY_AMP_WORKSPACE_MESSAGE = "legacy Amp workspace thread; start a new Amp (Orbs) thread";
