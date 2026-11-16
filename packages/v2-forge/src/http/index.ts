// Forge's portable HTTP surface: compose the handlers a host mounts, first match wins, `null` falls through to the host's own routes.
import { type Handler } from "./common";

export * from "./common";
export { codingRest, type RestDeps } from "./rest";
export { gitBroker, type GitBrokerDeps, type GitUpstream } from "./git-broker";
export { modelGateway, type GatewayDeps } from "./gateway";
export { codingVault, codingGitea, type LoginFlows } from "./vault";

/** The first handler that answers. */
export function compose(...handlers: (Handler | null | undefined)[]): Handler {
	return async (req) => {
		for (const h of handlers) {
			if (!h) continue;
			const r = await h(req);
			if (r) return r;
		}
		return null;
	};
}
