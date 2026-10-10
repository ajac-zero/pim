import { queryOptions } from "@tanstack/react-query";
import { pim } from "~/lib/pim-api";

/** Pim's lists. Live changes arrive on the socket and invalidate these. */

export const sessionsQuery = () =>
  queryOptions({ queryKey: ["sessions"], queryFn: pim.sessions });

export const approvalsQuery = () =>
  queryOptions({ queryKey: ["approvals"], queryFn: () => pim.approvals() });

export const alwaysApprovedQuery = () =>
  queryOptions({ queryKey: ["always-approved"], queryFn: pim.alwaysApproved });

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
