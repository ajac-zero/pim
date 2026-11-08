import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  type ArtifactFrom,
  admin,
  pim,
  type TriggerFilters,
} from "~/lib/pim-api";
import { triggersAvailable } from "~/lib/triggers";

/** Pim's lists. Live changes arrive on the socket and invalidate these. */

export const sessionsQuery = () =>
  queryOptions({ queryKey: ["sessions"], queryFn: pim.sessions });

export const majordomoQuery = () =>
  queryOptions({ queryKey: ["agents", "majordomo"], queryFn: pim.majordomo });

export const chatLinkQuery = (session: string) =>
  queryOptions({
    queryKey: ["chat-link", session],
    queryFn: () => pim.chatLink(session),
  });

export const sessionCostQuery = (session: string) =>
  queryOptions({
    queryKey: ["session-cost", session],
    queryFn: () => pim.sessionCost(session),
  });

export const approvalsQuery = () =>
  queryOptions({ queryKey: ["approvals"], queryFn: () => pim.approvals() });

/** Your own tools' permissions, or a circle's. */
export const permissionsQuery = (circle?: string) =>
  queryOptions({
    queryKey: ["permissions", circle ?? null],
    queryFn: () => pim.permissions(circle),
  });

/** Whether an agent may use each tool of its connectors. */
export const agentPermissionsQuery = (agent: string) =>
  queryOptions({
    queryKey: ["permissions", "agent", agent],
    queryFn: () => pim.agentPermissions(agent),
  });

/** Whether agents may write and install skills for an agent. */
export const agentSkillsPermissionQuery = (agent: string) =>
  queryOptions({
    queryKey: ["permissions", "agent", agent, "skills"],
    queryFn: () => pim.agentSkillsPermission(agent),
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

export const computerQuery = () =>
  queryOptions({ queryKey: ["computer"], queryFn: pim.computer });

/** The machine that keeps everyone's computers: the admin's view. */
export const computerHostQuery = () =>
  queryOptions({ queryKey: ["computer-host"], queryFn: admin.computerHost });

/** A chat's window in the agents' browser: its own, or that of a task it handed out. */
export const browserQuery = (sessionId: string) =>
  queryOptions({
    queryKey: ["browser", sessionId],
    queryFn: () => pim.browser(sessionId),
  });

export const artifactQuery = (id: string) =>
  queryOptions({
    queryKey: ["artifacts", id],
    queryFn: () => pim.artifact(id),
    // A deleted app answers 404: that's the answer, not a failure to retry.
    retry: false,
  });

export const artifactVersionQuery = (
  id: string,
  version: number,
  from?: ArtifactFrom,
  path?: string,
) =>
  queryOptions({
    queryKey: [
      ...(!from
        ? ["artifacts", id]
        : "host" in from
          ? ["shared-artifacts", from.host, id]
          : ["published-artifacts", id]),
      "versions",
      version,
      ...(path ? [path] : []),
    ],
    queryFn: () => pim.artifactVersion(id, version, from, path),
    retry: false,
  });

/** Apps people published for everyone, matching `query` if given. */
export const publishedArtifactsQuery = (query = "") =>
  queryOptions({
    queryKey: ["published-artifacts", "list", query],
    queryFn: () => pim.publishedArtifacts(query),
  });

export const publishedArtifactQuery = (id: string) =>
  queryOptions({
    queryKey: ["published-artifacts", id],
    queryFn: () => pim.publishedArtifact(id),
    retry: false,
  });

/** What you published of one of your apps, or null. */
/** How an app's backend is doing, asked again while it is shown. */
export const artifactBackendQuery = (id: string) =>
  queryOptions({
    queryKey: ["artifacts", id, "backend"],
    queryFn: () => pim.artifactBackend(id),
    refetchInterval: 5000,
  });

export const artifactBackendLogsQuery = (id: string) =>
  queryOptions({
    queryKey: ["artifacts", id, "backend", "logs"],
    queryFn: () => pim.artifactBackendLogs(id),
    refetchInterval: 3000,
  });

export const artifactPublicationQuery = (id: string) =>
  queryOptions({
    queryKey: ["artifacts", id, "publication"],
    queryFn: () => pim.artifactPublication(id),
  });

/** Apps people shared with you, from their spaces. */
export const sharedArtifactsQuery = () =>
  queryOptions({
    queryKey: ["shared-artifacts"],
    queryFn: () => pim.sharedArtifacts().then((body) => body.artifacts),
  });

export const sharedArtifactQuery = (host: string, id: string) =>
  queryOptions({
    queryKey: ["shared-artifacts", host, id],
    queryFn: () => pim.sharedArtifact(host, id),
    retry: false,
  });

export const skillsQuery = () =>
  queryOptions({ queryKey: ["skills"], queryFn: pim.skills });

export const skillQuery = (name: string) =>
  queryOptions({
    queryKey: ["skills", name],
    queryFn: () => pim.skill(name),
    // A deleted skill answers 404: that's the answer, not a failure to retry.
    retry: false,
  });

export const skillVersionQuery = (name: string, version: number) =>
  queryOptions({
    queryKey: ["skills", name, "versions", version],
    queryFn: () => pim.skillVersion(name, version),
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

/** What to suggest saying next in a chat: instant when Pim has them, a few seconds when it writes them. */
export const suggestionsQuery = (session: string, locale: string) =>
  queryOptions({
    queryKey: ["suggestions", session, locale],
    queryFn: () => pim.suggestions(session, locale),
    retry: false,
  });

/** How this deployment runs for everyone: the admin's view. */
export const deploymentQuery = () =>
  queryOptions({ queryKey: ["deployment"], queryFn: admin.deployment });

/** The agent everyone who joins starts with: the admin's view. */
export const defaultAgentQuery = () =>
  queryOptions({ queryKey: ["default-agent"], queryFn: admin.defaultAgent });

export const profileQuery = () =>
  queryOptions({ queryKey: ["profile"], queryFn: pim.profile });

export const emailQuery = () =>
  queryOptions({ queryKey: ["email"], queryFn: pim.email });

export const appsQuery = () =>
  queryOptions({ queryKey: ["apps"], queryFn: pim.apps });

/** The connectors you can connect: the extensions', and those the admin added. */
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

/**
 * Whether this space has triggers: false where the routes answer as unknown
 * paths (the gate is off) or for a guest. Nothing about triggers shows until
 * this is true.
 */
export const triggersAvailableQuery = () =>
  queryOptions({
    queryKey: ["triggers", "available"],
    queryFn: triggersAvailable,
    retry: false,
    staleTime: 5 * 60_000,
  });

/** One trigger. A missing one answers 404: no retries. */
export const triggerQuery = (id: string) =>
  queryOptions({
    queryKey: ["triggers", "one", id],
    queryFn: () => pim.trigger(id),
    retry: false,
  });

/** Triggers by the API's filters, a page at a time, oldest first. */
export const triggersQuery = (filters: TriggerFilters) =>
  infiniteQueryOptions({
    queryKey: ["triggers", "list", filters],
    queryFn: ({ pageParam }) => pim.triggers(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });

/** A trigger's runs, a page at a time, newest first. */
export const triggerRunsQuery = (id: string) =>
  infiniteQueryOptions({
    queryKey: ["triggers", "runs", id],
    queryFn: ({ pageParam }) => pim.triggerRuns(id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
