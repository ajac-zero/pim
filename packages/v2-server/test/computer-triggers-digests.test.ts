// The computer's triggers host and the server's side of the protocol compute the same digests, runtime id and envelope: a grant the person made is checked by both against these, so a difference would make every computer source refuse or run unsanctioned.
import { describe, expect, it } from "vitest";
import { grantScopeHash as hostGrantScope, TRIGGERS_ENVELOPE as HOST_ENVELOPE, triggersBinding } from "../../../computer/triggers-host.ts";
import { PROTOCOL as HOST_PROTOCOL, sourceConfigHash as hostConfigHash, type ComputerSource } from "../../../computer/triggers-runtime.ts";
import { TRIGGERS_ENVELOPE } from "@pim/v2-app/relay";
import { grantScopeHash, PROTOCOL, runtimeIdOfToken, sourceConfigHash } from "../src/computer-triggers.ts";

const OWNER = `o_${"a".repeat(26)}`;
const TOKEN = `pimc_${OWNER}_s3cr3t-computer-token`;

describe("the digests of a computer trigger", () => {
	it("are the same on the computer and on the server", () => {
		const sources: ComputerSource[] = [
			{ kind: "stream", command: "tail -F log | jq -c .", cwd: null },
			{ kind: "poll", command: "./price.sh", cwd: "/srv", intervalMs: 300_000, deadlineMs: 30_000 },
			{ kind: "process", handle: "proc-1", expiresAt: Date.UTC(2026, 10, 7) + 3_600_000 },
			{ kind: "file", path: "/home/ada/inbox", events: ["created", "deleted"], recursive: true },
		];
		for (const source of sources) expect(sourceConfigHash(source)).toBe(hostConfigHash(source));
		const binding = triggersBinding(TOKEN)!;
		const scope = { space: OWNER, runtimeId: binding.runtimeId, triggerId: "watch", sourceId: "watch#3", configHash: hostConfigHash(sources[0]!), grantRef: "approval-9" };
		expect(grantScopeHash(scope)).toBe(hostGrantScope(scope));
		expect(runtimeIdOfToken(TOKEN)).toBe(binding.runtimeId);
		expect(TRIGGERS_ENVELOPE).toBe(HOST_ENVELOPE);
		expect(PROTOCOL).toBe(HOST_PROTOCOL);
	});
});
