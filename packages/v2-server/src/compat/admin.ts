/**
 * The web app's apps, gallery, sharing and admin screens, answered over V2's own services under the paths and shapes the web app was written
 * against (what V2 calls an app the web app still calls an artifact). Handlers here are tried before the application's own routes for a
 * path both answer, and each authorizes as the application's routes do: the caller's principal, the Authorizer's `admin:*` actions, and the
 * caller's row-level security scope.
 */
import type { Route } from "@pim/v2-app/http";
import { artifactRoutes } from "./admin-apps.ts";
import { galleryRoutes } from "./admin-gallery.ts";
import { type ForgeHandler, screenRoutes } from "./admin-screens.ts";

export function adminCompatRoutes(env: Readonly<Record<string, string | undefined>>, coding: ForgeHandler): Route[] {
	return [...artifactRoutes(), ...galleryRoutes(env), ...screenRoutes(env, coding)];
}
