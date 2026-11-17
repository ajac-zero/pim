/**
 * The NATS side of the Relay bridge: how a Gate or Runner reaches a personal computer whose `pimc_` socket another process holds (the `relay` container,
 * or another Gate replica). `@pim/v2-app`'s `Relay` speaks `RelayBus`; this is its implementation over the connection Pulse already has.
 *
 *   pim.v2.relay.<ownerId>.rpc     request/reply: call, watch, open a stream; answered only by the process holding the owner's live socket
 *   pim.v2.relay.<ownerId>.stream  frames of open streams (screen, browser, app sockets), file events, and the "connected" notice that makes
 *                                  a replica holding an older connection for the owner close it with 4409
 *
 * A process subscribes to `pim.v2.relay.<ownerId>.*` for as long as it holds the owner's live socket, so a request with no subscriber fails at once
 * with NATS's "no responders": that is "no computer is connected", not a timeout. Like Pulse, the bus is trusted: its callers have authorized the
 * owner already, and a deployment keeps NATS inside its own network.
 */
import { OwnerId } from "@pim/v2-contracts/identity";
import { RelayNobody, type RelayBus, type RelayReply, type RelayRequest, type RelayStreamMessage } from "@pim/v2-app/relay";
import type { NatsPulse } from "@pim/v2-live/server/pulse";

export { acquireRemote, RelayNobody, type RelayBus } from "@pim/v2-app/relay";

const ROOT = "pim.v2.relay";
export const relaySubjects = {
	rpc: (ownerId: string) => `${ROOT}.${OwnerId.parse(ownerId)}.rpc`,
	stream: (ownerId: string) => `${ROOT}.${OwnerId.parse(ownerId)}.stream`,
	all: (ownerId: string) => `${ROOT}.${OwnerId.parse(ownerId)}.*`,
} as const;

export function natsRelayBus(pulse: NatsPulse): RelayBus {
	const nc = pulse.connection;
	const encoder = new TextEncoder();
	const subscriptions = new Set<{ unsubscribe(): void }>();
	return {
		serve(ownerId, handlers) {
			const sub = nc.subscribe(relaySubjects.all(ownerId), {
				callback: (error, message) => {
					if (error) return;
					const kind = message.subject.slice(message.subject.lastIndexOf(".") + 1);
					try {
						if (kind === "rpc") {
							handlers.rpc(message.json<RelayRequest>()).then(
								(reply) => message.respond(encoder.encode(JSON.stringify(reply))),
								(failed: Error) => message.respond(encoder.encode(JSON.stringify({ ok: false, status: 500, message: failed.message } satisfies RelayReply))),
							);
						} else if (kind === "stream") handlers.stream(message.json<RelayStreamMessage>());
					} catch {
						// A malformed message is a lost one.
					}
				},
			});
			subscriptions.add(sub);
			return () => {
				subscriptions.delete(sub);
				sub.unsubscribe();
			};
		},
		async request(ownerId, request, timeoutMs) {
			try {
				const reply = await nc.request(relaySubjects.rpc(ownerId), encoder.encode(JSON.stringify(request)), { timeout: timeoutMs });
				return reply.json<RelayReply>();
			} catch (error) {
				// Nobody subscribes to the owner's subject: no process holds a live socket.
				const cause = (error as { cause?: { name?: string } }).cause;
				if ((error as Error).name === "NoRespondersError" || cause?.name === "NoResponders" || cause?.name === "NoRespondersError") throw new RelayNobody();
				throw error;
			}
		},
		publish(ownerId, message) {
			nc.publish(relaySubjects.stream(ownerId), encoder.encode(JSON.stringify(message)));
		},
		subscribe(ownerId, handler) {
			const sub = nc.subscribe(relaySubjects.stream(ownerId), {
				callback: (error, message) => {
					if (error) return;
					try {
						handler(message.json<RelayStreamMessage>());
					} catch {
						// Ignored.
					}
				},
			});
			return () => sub.unsubscribe();
		},
	};
}
