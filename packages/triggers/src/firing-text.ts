/**
 * What the agent reads when a trigger fires, kept apart from the host so that what needs no Durable Object can use it (the Worker-free v2 application).
 */
import type { OlderFirings } from "./time";

/** What `firingText` reads of why a trigger fired: the parts of the coordinator's `TriggerEvidence` it puts in words. */
export type FiringEvidence =
	| { readonly kind: "time"; readonly triggerId: string; readonly label: string; readonly scheduledFor: number; readonly schedule: { readonly schedule: "once" | "cron" | "interval"; readonly timeZone?: string }; readonly older: OlderFirings | null }
	| { readonly kind: "connector_event"; readonly triggerId: string; readonly label: string; readonly connectorId: string; readonly event: string; readonly eventId: string; readonly observedAt: number }
	| { readonly kind: "computer_event"; readonly triggerId: string; readonly label: string; readonly source: "poll" | "stream" | "process"; readonly eventId: string; readonly observedAt: number };

/**
 * What the agent reads when a trigger fires: its instruction, and only when
 * it was due, which connector's event it was, by name, id and time, or which
 * kind of source on the person's computer saw something, with the event's id
 * and time. A connector's event reads as a `[Connector event]` message, as
 * `watch_connector_event` promises (../extensions/app-events.ts), followed by
 * what the event carried where Pim kept it for the run (`contents`, which
 * marks it as data, not instructions). What an observer on the computer saw
 * is never kept, so it is never here.
 */
export function firingText(instruction: string, evidence: FiringEvidence, contents: string | null = null): string {
	if (evidence.kind === "connector_event") {
		const head = `[Connector event] ${evidence.connectorId} sent "${evidence.event}" (event ${evidence.eventId} at ${new Date(evidence.observedAt).toISOString()}) for trigger "${evidence.label}" ${evidence.triggerId}.\nYour instruction for this trigger: ${instruction}`;
		return `${head}\n${contents ?? "What the event carried isn't kept or passed on."}`;
	}
	if (evidence.kind === "computer_event") {
		return `[Trigger "${evidence.label}" ${evidence.triggerId}] ${instruction}\n\n(On what its ${evidence.source} on the person's computer saw at ${new Date(evidence.observedAt).toISOString()}, event ${evidence.eventId}. What it saw isn't kept or passed on.)`;
	}
	const missed = evidence.older && evidence.older.count > 0 ? ` ${evidence.older.count} earlier ${evidence.older.count === 1 ? "firing" : "firings"} were missed and won't run.` : "";
	const zone = evidence.schedule.schedule === "cron" ? ` (${evidence.schedule.timeZone})` : "";
	return `[Trigger "${evidence.label}" ${evidence.triggerId}] ${instruction}\n\n(Due at ${new Date(evidence.scheduledFor).toISOString()}${zone}.${missed})`;
}
