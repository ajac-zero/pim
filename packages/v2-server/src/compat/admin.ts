/**
 * The web app's apps, gallery, sharing and admin screens, answered over V2's own services under the paths and shapes the web app was written
 * against (what V2 calls an app the web app still calls an artifact). Each handler authorizes as the application's routes do: the caller's
 * principal, the Authorizer's `admin:*` actions, and the caller's row-level security scope.
 */
import type { Route } from "@pim/v2-app/http";
import { adminDirectoryRoutes } from "./admin-directory.ts";
import { artifactRoutes } from "./admin-apps.ts";
import { galleryRoutes } from "./admin-gallery.ts";
import { screenRoutes } from "./admin-screens.ts";

export { poolRoutes } from "./admin-screens.ts";

export const adminCompatRoutes: Route[] = [...adminDirectoryRoutes(), ...artifactRoutes(), ...galleryRoutes(process.env), ...screenRoutes(process.env)];
