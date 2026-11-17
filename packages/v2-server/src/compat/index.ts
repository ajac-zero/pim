/**
 * The web app (web/) was built against the v1 Worker's API. These routes answer the paths and shapes it calls over v2's services, area by area,
 * each in a file of its own. They are tried before the Gate's built-in routes. A feature v2 does not have yet answers as v1 did when it was not
 * configured, so the app shows it as off rather than failing.
 */
import { NotFoundError } from "@pim/v2-app/errors";
import type { Reply, Route } from "@pim/v2-app/http";
import { CapabilityUnavailableError } from "@pim/v2-contracts/authz";
import { fileRoutes } from "./chat-files.ts";
import { adminCompatRoutes } from "./admin.ts";
import { bootRoutes } from "./boot.ts";
import { modelRoutes } from "./model.ts";
import { computerRoutes } from "./computer.ts";
import { connectorRoutes } from "../connector-routes.ts";
import { chatRoutes } from "./chat.ts";
import { apiClientRoutes } from "./api-clients.ts";
import { diagnosticsRoutes } from "./diagnostics.ts";
import { usageRoutes } from "./usage.ts";
import { bridgeRoutes } from "./app-bridge.ts";
import { notificationRoutes } from "./notifications.ts";
import { connectorScreens } from "./connectors.ts";
import { chatgptImagesRoutes } from "./chatgpt-images.ts";
import { guestRoutes } from "./guests.ts";
import { hostRoutes, managedComputerRoutes } from "../hostops/routes.ts";

/**
 * The files screen has two stores: the paired computer's folder (`computer.ts`) and the objects an agent saves under /workspace without one, such as the images it draws
 * (`chat-files.ts`). A listing shows both; a file is read from the objects first, then the computer; a write or delete goes to the computer, or to the objects when none
 * is connected (or, for a delete, when the computer has no such file).
 */
function filesOverBoth(computer: Route[], objects: Route[]): Route[] {
	const mine = (r: Route, other: Route[]) => other.find((o) => o.method === r.method && o.pattern.source === r.pattern.source);
	const none = (error: unknown) => error instanceof CapabilityUnavailableError;
	return computer.map((c) => {
		const o = mine(c, objects);
		if (!o) return c;
		const key = `${c.method} ${c.pattern.source}`;
		const run: Route["run"] = async (ctx) => {
			if (key.startsWith("GET") || key.startsWith("HEAD")) {
				if (c.pattern.source.includes("content")) return o.run(ctx).catch((error) => (error instanceof NotFoundError ? c.run(ctx).catch((inner) => Promise.reject(none(inner) ? error : inner)) : Promise.reject(error)));
				const [fromObjects, fromComputer] = [await o.run(ctx), await c.run(ctx).catch((error) => (none(error) ? undefined : Promise.reject(error)))];
				if (!fromComputer) return fromObjects;
				const entries = new Map<string, { path: string; name: string; type: string }>();
				for (const r of [fromObjects, fromComputer] as Reply[]) for (const e of (r.body as { entries: { path: string; name: string; type: string }[] }).entries) entries.set(e.path, e);
				const sorted = [...entries.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
				return { ...fromComputer, body: { ...(fromComputer.body as object), entries: sorted } };
			}
			return c.run(ctx).catch((error) => (none(error) || (key.startsWith("DELETE") && error instanceof NotFoundError) ? o.run(ctx) : Promise.reject(error)));
		};
		return { ...c, run };
	});
}

export const webCompatRoutes: Route[] = [
	// Circles, visits and a guest's bot first: they replace the application's own answers to the same paths, which the web app does not read.
	...guestRoutes(),
	...notificationRoutes(process.env),
	// Connectors come first: their approve and deny add "always approve" to the plain decision the boot routes make.
	...connectorScreens(),
	...connectorRoutes(),
	...bootRoutes,
	// Model settings first: /api/providers/built-in is answered by both, and the model work's answer is the one the provider forms use.
	...modelRoutes(process.env),
	...chatgptImagesRoutes(process.env),
	// The computer host and host operations, and a person's computer where the host keeps it (`../hostops/`): before the computer routes, which answer none paired.
	...hostRoutes(),
	...filesOverBoth(managedComputerRoutes(computerRoutes()), fileRoutes()),
	...bridgeRoutes(process.env),
	...adminCompatRoutes,
	...chatRoutes,
	...usageRoutes(),
	...apiClientRoutes(),
	...diagnosticsRoutes(process.env),
];
