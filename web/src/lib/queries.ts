import { queryOptions } from "@tanstack/react-query";
import { pim } from "~/lib/pim-api";

/** Pim's lists. Live changes arrive on the socket and invalidate these. */

export const sessionsQuery = () =>
  queryOptions({ queryKey: ["sessions"], queryFn: pim.sessions });

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

export const modelQuery = () =>
  queryOptions({ queryKey: ["model"], queryFn: pim.model });

export const settingsQuery = () =>
  queryOptions({ queryKey: ["settings"], queryFn: pim.settings });

export const accountQuery = () =>
  queryOptions({ queryKey: ["account"], queryFn: pim.account });

export const artifactsQuery = () =>
  queryOptions({ queryKey: ["artifacts"], queryFn: pim.artifacts });

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

export const personasQuery = () =>
  queryOptions({ queryKey: ["personas"], queryFn: pim.personas });

export const profileQuery = () =>
  queryOptions({ queryKey: ["profile"], queryFn: pim.profile });

export const appsQuery = () =>
  queryOptions({ queryKey: ["apps"], queryFn: pim.apps });

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
