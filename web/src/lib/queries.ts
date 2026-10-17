import { queryOptions } from "@tanstack/react-query";
import { admin, pim } from "~/lib/pim-api";

/** Pim's lists. Live changes arrive on the socket and invalidate these. */

export const sessionsQuery = () =>
  queryOptions({ queryKey: ["sessions"], queryFn: pim.sessions });

export const majordomoQuery = () =>
  queryOptions({ queryKey: ["agents", "majordomo"], queryFn: pim.majordomo });

export const approvalsQuery = () =>
  queryOptions({ queryKey: ["approvals"], queryFn: () => pim.approvals() });

/** Your own tools' permissions, or a circle's. */
export const permissionsQuery = (circle?: string) =>
  queryOptions({
    queryKey: ["permissions", circle ?? null],
    queryFn: () => pim.permissions(circle),
  });

export const circlesQuery = () =>
  queryOptions({ queryKey: ["circles"], queryFn: pim.circles });

export const guestActivityQuery = () =>
  queryOptions({ queryKey: ["guest-activity"], queryFn: pim.guestActivity });

export const visitsQuery = () =>
  queryOptions({ queryKey: ["visits"], queryFn: pim.visits });

export const notificationsQuery = () =>
  queryOptions({ queryKey: ["notifications"], queryFn: pim.notifications });

export const schedulesQuery = () =>
  queryOptions({ queryKey: ["schedules"], queryFn: pim.schedules });

export const modelQuery = () =>
  queryOptions({ queryKey: ["model"], queryFn: pim.model });

export const settingsQuery = () =>
  queryOptions({ queryKey: ["settings"], queryFn: pim.settings });

export const accountQuery = () =>
  queryOptions({ queryKey: ["account"], queryFn: pim.account });

/** Everyone on this Pim: the admin's view. */
export const membersQuery = () =>
  queryOptions({ queryKey: ["members"], queryFn: admin.members });

export const artifactsQuery = () =>
  queryOptions({ queryKey: ["artifacts"], queryFn: pim.artifacts });

/** A folder of your files. A folder that's gone answers 404: no retries. */
export const filesQuery = (path: string) =>
  queryOptions({
    queryKey: ["files", path],
    queryFn: () => pim.files(path),
    retry: false,
  });

export const artifactQuery = (id: string) =>
  queryOptions({
    queryKey: ["artifacts", id],
    queryFn: () => pim.artifact(id),
    // A deleted artifact answers 404: that's the answer, not a failure to retry.
    retry: false,
  });

export const artifactVersionQuery = (id: string, version: number) =>
  queryOptions({
    queryKey: ["artifacts", id, "versions", version],
    queryFn: () => pim.artifactVersion(id, version),
    retry: false,
  });

export const agentsQuery = () =>
  queryOptions({ queryKey: ["agents"], queryFn: pim.agents });

/** The deployment's extensions: they change only with a deploy. */
export const extensionsQuery = () =>
  queryOptions({
    queryKey: ["extensions"],
    queryFn: pim.extensions,
    staleTime: Number.POSITIVE_INFINITY,
  });

/** An agent's dashboard. Refetched when Pim's activity or the agent itself changes. */
export const dashboardQuery = (id: string, locale: string) =>
  queryOptions({
    queryKey: ["dashboard", id, locale],
    queryFn: () => pim.dashboard(id, locale),
    retry: false,
  });

/** The agent everyone who joins starts with: the admin's view. */
export const defaultAgentQuery = () =>
  queryOptions({ queryKey: ["default-agent"], queryFn: admin.defaultAgent });

export const profileQuery = () =>
  queryOptions({ queryKey: ["profile"], queryFn: pim.profile });

export const emailQuery = () =>
  queryOptions({ queryKey: ["email"], queryFn: pim.email });

export const appsQuery = () =>
  queryOptions({ queryKey: ["apps"], queryFn: pim.apps });

/** The apps you can connect: the extensions', and those the admin added. */
export const appDirectoryQuery = () =>
  queryOptions({ queryKey: ["app-directory"], queryFn: pim.appDirectory });

export const templatesQuery = (query: string) =>
  queryOptions({
    queryKey: ["templates", query],
    queryFn: () => pim.templates(query),
  });

export const templateQuery = (id: string) =>
  queryOptions({
    queryKey: ["templates", "one", id],
    queryFn: () => pim.template(id),
    retry: false,
  });

export const personQuery = (username: string) =>
  queryOptions({
    queryKey: ["people", username],
    queryFn: () => pim.person(username),
    retry: false,
  });
