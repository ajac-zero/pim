import { selfHostedSite, servePim } from "./gateway";

export { Pim } from "./agent";
export { Auth } from "./auth";

/**
 * A self-hosted Pim: one Worker, one person. Every request is for the same
 * owner, whose agent and sign-in keep the Durable Object names they have
 * always had. The hosted service's entry is ./hosted/index.ts.
 */
export default {
	fetch(request, env): Promise<Response> {
		return servePim(request, env, selfHostedSite(env));
	},
} satisfies ExportedHandler<Env>;
