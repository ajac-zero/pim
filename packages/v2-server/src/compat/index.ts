/**
 * The web app (web/) was built against the v1 Worker's API. These routes answer the paths and shapes it calls over v2's services, area by area,
 * each in a file of its own. They are tried before the Gate's built-in routes. A feature v2 does not have yet answers as v1 did when it was not
 * configured, so the app shows it as off rather than failing.
 */
import type { Route } from "@pim/v2-app/http";
import { bootRoutes } from "./boot.ts";
import { modelRoutes } from "./model.ts";
import { computerRoutes } from "./computer.ts";

export const webCompatRoutes: Route[] = [
	...bootRoutes,
	...modelRoutes(process.env),
	...computerRoutes(),
];
