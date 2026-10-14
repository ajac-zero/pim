import { serve } from "./gateway";

export { Pim } from "./pim";
export { Auth } from "./auth";
export { Directory } from "./directory";
export { Gallery } from "./gallery";

/**
 * A Pim: one Worker for everyone on it, each with their own agent. The
 * first account is the admin's; see ./gateway.ts for how a request finds
 * whose it is.
 */
export default {
	fetch(request, env): Promise<Response> {
		return serve(request, env);
	},
} satisfies ExportedHandler<Env>;
