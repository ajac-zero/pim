/**
 * Asking the person to let a trigger's source run on their computer, and
 * recording their answer as a grant (./computer.ts). An agent calls
 * `trigger_computer_grant` with a trigger's id; the tool works out the
 * grant's exact scope (this space, the computer paired now, the trigger,
 * its source's identity and the digest of its configuration) and files an
 * approval of `trigger_computer_source` with exactly that scope as its
 * arguments, which only the person may decide: no timeout, "always
 * approve" or majordomo decides it (`explicitApproval`). Once they approve,
 * the action records the grant, points the trigger at it, and the computer
 * hears what it should run. What they read says plainly that the command
 * runs as their own user, with that user's access.
 *
 * Pim offers the tool wherever the space's triggers are, and the action
 * runs only where its trigger engine is on. With no computer paired, the
 * tool refuses: there is nothing to grant a source on.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { approvalNote, fileApproval, type GatedAction } from "../extensions/approvals";
import { type PimServices, text } from "../extensions/services";
import { COMPUTER_GRANT_ACTION, type ComputerGrants, type ComputerSource, type GrantScope, sourceConfigHash } from "./computer";
import { type PollSource, type ProcessSource, runsOnComputer, type StreamSource } from "./spec";
import type { TriggerStore } from "./store";

/** The tool agents ask for a grant with, and the extension that offers it. */
export const COMPUTER_GRANT_TOOL = "trigger_computer_grant";
export const COMPUTER_GRANT_EXTENSION = "pim.triggers.computer";

/** What a grant of a trigger's source would be, with what the person reads to decide; or why there can be none. */
export type GrantRequest = { readonly scope: GrantScope; readonly summary: string } | { readonly refused: string };

/** What the tool and the action need of the space. */
export type ComputerGrantHost = {
	/** What a grant of this trigger's current source would be. */
	request(triggerId: string): GrantRequest;
	/** The person approved `approvalId`: records its grant, and returns what the agent is told. */
	granted(approvalId: string): string;
};

function every(ms: number): string {
	if (ms % 3_600_000 === 0) return ms === 3_600_000 ? "every hour" : `every ${ms / 3_600_000} hours`;
	if (ms % 60_000 === 0) return ms === 60_000 ? "every minute" : `every ${ms / 60_000} minutes`;
	return `every ${ms / 1000} seconds`;
}

/** What the person reads to decide: what runs, how often, and that it runs as them, with their access. */
export function grantSummary(label: string, source: PollSource | StreamSource | ProcessSource): string {
	const where = "cwd" in source && source.cwd ? ` in ${source.cwd}` : "";
	const as = "It runs as your own user on the computer, with everything that user can reach, until you revoke it or the trigger stops.";
	switch (source.kind) {
		case "poll":
			return `Let the trigger "${label}" run \`${source.command}\`${where} on your computer ${every(source.intervalMs)}. ${as}`;
		case "stream":
			return `Let the trigger "${label}" keep \`${source.command}\`${where} running on your computer and read what it prints. ${as}`;
		case "process":
			return `Let the trigger "${label}" watch on your computer for the process ${source.handle} to exit, until ${new Date(source.expiresAt).toISOString()}.`;
	}
}

/** What a grant of a trigger's current source would be: its exact scope on the computer paired now (`runtimeId`), or why there is none. */
export function grantRequest(store: TriggerStore, space: string, runtimeId: string | null, triggerId: string): GrantRequest {
	const trigger = store.get(triggerId);
	if (!trigger || trigger.lifecycle === "deleted") return { refused: `There is no trigger ${triggerId}.` };
	const source = trigger.spec.source;
	if (!runsOnComputer(source)) return { refused: `The trigger "${trigger.spec.label}" doesn't run on the computer, so it needs no grant.` };
	if (source.kind === "file") return { refused: "Nothing on the computer watches files yet, so a file source can't be granted." };
	if (trigger.lifecycle === "ended") return { refused: `The trigger "${trigger.spec.label}" has ended.` };
	if (runtimeId === null) return { refused: "No computer is paired, so there is nothing to grant this on. The person can pair one in Settings → Computer." };
	const state = store.sourceState(triggerId)!;
	return { scope: { space, runtimeId, triggerId, sourceId: state.identity, configHash: sourceConfigHash(source as ComputerSource) }, summary: grantSummary(trigger.spec.label, source as PollSource | StreamSource | ProcessSource) };
}

/**
 * Records the grant the person's approval gave, and points its trigger at
 * it, while the trigger's source is still the one they approved. What the
 * agent is told says what happened.
 */
export function recordGrant(store: TriggerStore, grants: ComputerGrants, approvalId: string): string {
	const recorded = grants.record(approvalId);
	if (!recorded.ok) return recorded.reason === "revoked" ? "Nothing was granted: this grant was revoked." : "Nothing was granted: only the person's own approval of exactly this source grants it.";
	const { scope } = recorded;
	const trigger = store.get(scope.triggerId);
	const state = store.sourceState(scope.triggerId);
	if (!trigger || trigger.lifecycle === "deleted" || !state || state.identity !== scope.sourceId || !runsOnComputer(trigger.spec.source) || sourceConfigHash(trigger.spec.source as ComputerSource) !== scope.configHash) {
		return "The person approved, but the trigger has changed or gone since, so the grant covers nothing it runs now. Ask again for what it is now.";
	}
	if (trigger.spec.authorizationRef !== approvalId) {
		const updated = store.update({ id: trigger.id, expectedRevision: trigger.revision, spec: { ...trigger.spec, authorizationRef: approvalId } });
		if (!updated.ok) return `The person approved, but the trigger couldn't be pointed at the grant (${updated.reason}). Ask again.`;
	}
	const enabled = store.get(trigger.id)!.lifecycle === "enabled";
	return `Granted: the trigger "${trigger.spec.label}" may run its source on the person's computer${enabled ? "" : " once it is enabled"}. The person can revoke this at any time.`;
}

/** The action an approved grant runs. It has no tool of its own: `trigger_computer_grant` files it. */
export function computerGrantAction(host: () => ComputerGrantHost | null): GatedAction {
	return {
		name: COMPUTER_GRANT_ACTION,
		description: "Lets a trigger's source run on the person's computer, as the person approved it.",
		parameters: Type.Object({ space: Type.String(), runtimeId: Type.String(), triggerId: Type.String(), sourceId: Type.String(), configHash: Type.String() }),
		summarize: (args) => `Let the trigger ${(args as { triggerId: string }).triggerId} run on your computer`,
		async run(_args, request) {
			const on = host();
			if (!on) throw new Error("Triggers on the computer are off.");
			if (!request.approval) throw new Error("A grant comes only from an approval.");
			return on.granted(request.approval);
		},
		internal: true,
		explicitApproval: true,
	};
}

/** The tool agents ask for a grant with, which only the person can answer. */
export function computerGrantExtension(services: PimServices, host: ComputerGrantHost) {
	return defineExtension({
		name: COMPUTER_GRANT_EXTENSION,
		tools: [
			defineTool({
				name: COMPUTER_GRANT_TOOL,
				description: `Asks the person to let a trigger's source (a poll, a stream or a process watch) run on their computer, exactly as the trigger has it now. A changed source needs asking again. ${approvalNote(services, true)}`,
				parameters: Type.Object({ triggerId: Type.String({ description: "The trigger's id." }) }),
				replay: "safe",
				async execute(args, api, context) {
					const asked = host.request(args.triggerId);
					if ("refused" in asked) return text(asked.refused, true);
					return fileApproval(services, api, context, { action: COMPUTER_GRANT_ACTION, tool: null, args: asked.scope, summary: asked.summary }, true);
				},
			}),
		],
	});
}
