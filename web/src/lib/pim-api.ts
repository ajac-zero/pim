import type { AgentEvent } from "@earendil-works/pi-durable";

/**
 * Pim's REST API, reached through this app's own `/api` path: the app's
 * Worker forwards it to Pim and adds the API token, so the browser never
 * holds it. Shapes follow Pim's README.
 */

export type Session = {
  id: string;
  title: string | null;
  busy: boolean;
  createdAt: number | null;
  updatedAt: number | null;
  /** A conversation with someone else's Pim, shared with you; null for your own chats. */
  visit?: { username: string; available: boolean } | null;
  /** The Pim of yours it talks with: the one it was started with, or your default one. Null in a visit. */
  persona?: { id: string; name: string } | null;
};

/** An app a Pim suggests connecting, by its MCP server URL. */
export type SuggestedApp = { name: string; url: string };

/** One of a Pim's team: it does tasks the Pim hands it, and answers the Pim, never you. */
export type TeamMember = {
  name: string;
  instructions: string;
  /** The tools it may use, by name; null for all the Pim's tools a member can have. */
  tools: string[] | null;
};

/** A conversation's message, as the REST API projects it. */
export type TranscriptMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "notice";
  parts: (
    | { type: "text" | "thinking"; text: string }
    | { type: "tool-call"; id: string; name: string; arguments: unknown }
    | {
        type: "tool-result";
        id: string;
        name: string;
        content: { type: string; text?: string }[];
        error: boolean;
      }
    | { type: "image" }
  )[];
  timestamp: number;
  error?: string;
};

/** A task a Pim handed a member of its team, in the member's own conversation. */
export type TeamRun = {
  conversation: string;
  /** Tasks handed out together share it. */
  call: string;
  session: string;
  persona: string;
  member: string;
  task: string;
  status: "running" | "done" | "failed";
  createdAt: number;
  updatedAt: number;
};

/** How long a Pim's name may be. */
export const MAX_PIM_NAME = 60;

/** One of your Pims: a named agent with its own instructions. */
export type Persona = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  apps: SuggestedApp[];
  team: TeamMember[];
  /** The extension's Pim it builds on, as `<extension>/<pim>`, which brings its dashboard; null for none. */
  base: string | null;
  /** The template it was made from. */
  source: { template: string; author: string } | null;
  /** Its template in the gallery, while published. */
  published: string | null;
  /** When its icon was set, or null without one. */
  icon: number | null;
  /** The one that talks in chats started without choosing a Pim. It can't be deleted while it is. */
  default: boolean;
  createdAt: number;
  updatedAt: number;
};

/** Where a widget's item leads. */
export type WidgetLink = { chat: string } | { artifact: string };

export type WidgetListItem = {
  title: string;
  detail?: string;
  /** ISO 8601. */
  time?: string;
  link?: WidgetLink;
};

export type WidgetProgressItem = {
  title: string;
  value: number;
  max: number;
  detail?: string;
  link?: WidgetLink;
};

/** One card of a dashboard, loaded by the extension that brings it, in the kind the app draws. */
export type Widget = { id: string; title: string; empty: string } & (
  | { kind: "list"; items: WidgetListItem[] }
  | { kind: "progress"; items: WidgetProgressItem[] }
  | { failed: true }
);

export type Dashboard = {
  pim: Pick<
    Persona,
    "id" | "name" | "description" | "default" | "base" | "icon"
  >;
  /** Messages to start a chat with. */
  starters: string[];
  widgets: Widget[];
};

export type PersonaInput = {
  name: string;
  description: string;
  instructions: string;
  apps: SuggestedApp[];
  team: TeamMember[];
  /** Left out, a new Pim builds on the deployment's default Pim. */
  base?: string | null;
};

/** What this deployment installed: the Pims people can build on, and widgets. */
export type InstalledExtension = {
  id: string;
  name: string;
  description: string;
  pims: { ref: string; name: string; description: string }[];
  widgets: string[];
};

export type Extensions = {
  extensions: InstalledExtension[];
  /** What new Pims build on when not told otherwise. */
  defaultPim: string | null;
};

/** A Pim someone published for others to make their own. */
export type Template = {
  id: string;
  author: string;
  authorName: string | null;
  name: string;
  description: string;
  instructions: string;
  apps: SuggestedApp[];
  team: TeamMember[];
  publishedAt: number;
  uses: number;
};

export type TemplateSummary = Omit<Template, "instructions">;

export type Profile = {
  username: string;
  displayName: string | null;
  bio: string | null;
};

/** Someone on this Pim, and what they published. */
export type Person = Profile & { templates: TemplateSummary[] };

/** A connected app, as Pim lists them. */
export type ConnectedApp = {
  id: string;
  name: string;
  url: string;
  state: string;
};

export type ApprovalStatus = "pending" | "approved" | "denied";

export type Approval = {
  id: string;
  session: string;
  action: string;
  /** The tool the model called; null for approvals filed before it was recorded. */
  tool: string | null;
  args: unknown;
  summary: string;
  status: ApprovalStatus;
  note: string | null;
  result: string | null;
  createdAt: number;
  decidedAt: number | null;
  /** The tool call that filed it. */
  callId: string | null;
  /** When the timeout decides it, if still pending. */
  expiresAt: number | null;
  /** What the timeout decides: approve (the auto policy) or deny (explicit). Missing from older Pims, which approve. */
  onTimeout?: "approve" | "deny";
  /** Who decided: the user, the timeout, or "always approve". */
  decidedBy?: "user" | "timeout" | "always" | null;
  /** Someone in one of your circles asked, from their own Pim; null when your Pim asked. */
  requestedBy?: {
    ownerId: string;
    username: string;
    circle: string;
    circleName: string;
  } | null;
  /** A member of a Pim's team asked, working for the chat `session` names; the approval's own `session` is the member's. */
  member?: { name: string; session: string } | null;
};

/** One of your circles: people who may message your Pim, and what they may use. */
export type Circle = {
  id: string;
  name: string;
  enabled: boolean;
  createdAt: number;
  members: { ownerId: string; username: string; addedAt: number }[];
};

/** A tool call from someone in your circles. */
export type GuestActivity = {
  id: number;
  at: number;
  username: string;
  circle: string;
  tool: string;
  outcome: "ran" | "asked" | "refused";
  summary: string;
};

/** Someone else's Pim, shared with you. */
export type Visit = {
  ownerId: string;
  username: string;
  sharedAt: number;
  /** False once they took it back. */
  available: boolean;
  /** Your conversation with it, once started. */
  session: string | null;
};

export type ApprovalPolicy = "auto" | "explicit";

/** The address Pim emails you at. */
export type EmailState = {
  /** This Pim can send email at all. */
  available: boolean;
  /** The confirmed address, or null. */
  address: string | null;
  /** An address waiting for the code Pim emailed it, or null. */
  pending: string | null;
};

export type PimSettings = {
  timeZone: string;
  approvalPolicy: ApprovalPolicy;
  /** Null: approvals wait for an answer however long. */
  approvalTimeoutSeconds: number | null;
  notifyWebhook: string | null;
};

export type Limits = {
  dailyTokens: number | null;
  dailyModelRequests: number | null;
  dailyRuns: number | null;
  sessions: number | null;
  schedules: number | null;
  apps: number | null;
  storageBytes: number | null;
  artifacts: number | null;
  artifactVersions: number | null;
  artifactBytes: number | null;
  artifactStorageBytes: number | null;
};

export type ArtifactKind = "html" | "markdown";

/** An artifact, as its latest version. */
export type Artifact = {
  id: string;
  title: string;
  kind: ArtifactKind;
  session: string | null;
  version: number;
  versions: number;
  size: number;
  sha256: string;
  createdAt: number;
  updatedAt: number;
};

export type ArtifactVersionInfo = {
  version: number;
  sha256: string;
  size: number;
  /** "restore": the person restored `restoredFrom`. */
  source: "agent" | "restore";
  restoredFrom: number | null;
  createdAt: number;
};

export type ArtifactDetail = Artifact & { history: ArtifactVersionInfo[] };

export type ArtifactVersion = ArtifactVersionInfo & {
  id: string;
  title: string;
  kind: ArtifactKind;
  latest: number;
  content: string;
};

/** What an artifact tool answers: a reference to the version it made, never its content. */
export type ArtifactReference = {
  id: string;
  title: string;
  kind: ArtifactKind;
  version: number;
  sha256: string;
  size: number;
};

const artifactPath = (id: string, version: number) =>
  `/api/artifacts/${encodeURIComponent(id)}/versions/${version}`;

/** The sandboxed page an HTML artifact's version is shown in. */
export const artifactFrameUrl = (id: string, version: number) =>
  `${artifactPath(id, version)}/frame`;

/** Where the browser downloads a version, as a file. */
export const artifactDownloadUrl = (id: string, version: number) =>
  `${artifactPath(id, version)}/download`;

export type DayUsage = {
  day: string;
  tokens: number;
  planTokens: number;
  modelRequests: number;
  runs: number;
};

export type UsageReport = {
  limits: Limits;
  today: DayUsage;
  history: DayUsage[];
  storageBytes: number;
};

/** Your account on this Pim. */
export type Account = {
  username: string;
  ownerId: string;
  role: "admin" | "member";
  status: "active" | "pending" | "suspended";
  createdAt: number;
  usage: UsageReport;
  recoveryCodesLeft: number;
};

/** Someone's account, as the admin sees it. */
export type Member = {
  ownerId: string;
  username: string;
  role: "admin" | "member";
  status: "pending" | "active" | "suspended" | "deleting" | "deleted";
  createdAt: number;
  activatedAt: number | null;
  statusReason: string | null;
};

/** Whether Pim may use a tool: not at all, after asking you, or without asking. */
export type ToolPermission = "off" | "ask" | "on";

/** A tool you can set a permission for, and the permission that applies. */
export type ToolPermissionInfo = {
  /** The connected app's id; null for Pim's own tools. */
  app: string | null;
  appName: string | null;
  /** The tool's own name, which its permission is set by. */
  tool: string;
  /** The name the model sees. */
  name: string;
  description: string | null;
  /** The app says the tool only reads. */
  readOnly: boolean;
  permission: ToolPermission;
  /** What applies when you haven't chosen. */
  default: ToolPermission;
  chosen: ToolPermission | null;
  /** The app changed the tool since you chose to let it run: Pim asks again, and circles lose it. */
  changed: boolean;
  /** The permissions it can have. */
  choices: ToolPermission[];
};

export type PimNotification = {
  id: string;
  session: string | null;
  title: string;
  body: string;
  createdAt: number;
  readAt: number | null;
};

export type ModelInfo = { provider: string; id: string; name: string };

export type ChatGPTStatus = { connected: boolean; email: string | null };

export type ModelSettings = {
  /** The model every session uses. */
  model: ModelInfo;
  /** The deployment's own model, used when nothing else is chosen. */
  default: ModelInfo;
  choices: ModelInfo[];
  chatgpt: ChatGPTStatus & { error: string | null };
};

/** OpenAI's provider id: models that run on the ChatGPT plan. */
export const CHATGPT_PROVIDER = "openai";

/** What Pim sends on a session's WebSocket. */
export type ServerMessage =
  | { type: "hello"; session: string; tools: unknown[] }
  | { type: "events"; session: string; events: AgentEvent[] }
  | { type: "notification"; notification: PimNotification }
  | { type: "approval"; approval: Approval }
  | { type: "visits" }
  | { type: "result"; id: string; result: unknown }
  | { type: "error"; id?: string; message: string };

/** An API answer that isn't a success, with its status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The Access sign-in lapsed: the page must reload to sign in again. */
export class SignInRequired extends Error {
  constructor() {
    super("Your sign-in expired. Reload the page to sign in again.");
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    // Access answers an expired session with a redirect to its sign-in page.
    redirect: "manual",
    headers: { "content-type": "application/json", ...init.headers },
  });
  if (response.type === "opaqueredirect" || response.status === 401) {
    throw new SignInRequired();
  }
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body?.error ?? `Pim answered ${response.status}`,
    );
  }
  return body as T;
}

export const pim = {
  sessions: () =>
    call<{ sessions: Session[] }>("/sessions").then((body) => body.sessions),
  createSession: (options: { title?: string; persona?: string } = {}) =>
    call<Session>("/sessions", {
      method: "POST",
      body: JSON.stringify(options),
    }),
  personas: () =>
    call<{ personas: Persona[] }>("/personas").then((body) => body.personas),
  createPersona: (input: PersonaInput) =>
    call<Persona>("/personas", { method: "POST", body: JSON.stringify(input) }),
  updatePersona: (id: string, input: Partial<PersonaInput>) =>
    call<Persona>(`/personas/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  setPersonaIcon: async (id: string, icon: Blob) => {
    const response = await fetch(`/api/personas/${id}/icon`, {
      method: "PUT",
      headers: { "content-type": icon.type },
      body: icon,
    });
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    if (!response.ok) {
      throw new ApiError(
        response.status,
        body?.error ?? `Pim answered ${response.status}`,
      );
    }
  },
  removePersonaIcon: (id: string) =>
    call<Persona>(`/personas/${id}/icon`, { method: "DELETE" }),
  deletePersona: (id: string) =>
    call<{ deleted: boolean }>(`/personas/${id}`, { method: "DELETE" }),
  extensions: () => call<Extensions>("/extensions"),
  /** Makes it the Pim chats started without choosing one talk with. */
  makeDefaultPersona: (id: string) =>
    call<Persona>(`/personas/${id}/default`, { method: "POST" }),
  /** A Pim's dashboard, with its text in `locale` where the extensions translated it. */
  dashboard: (id: string, locale: string) =>
    call<Dashboard>(
      `/personas/${id}/dashboard?locale=${encodeURIComponent(locale)}`,
    ),
  publishPersona: (id: string) =>
    call<Template>(`/personas/${id}/publish`, { method: "POST" }),
  unpublishPersona: (id: string) =>
    call<{ deleted: boolean }>(`/personas/${id}/publish`, { method: "DELETE" }),
  /** What a chat's Pim handed its team, newest first. */
  teamRuns: (session: string) =>
    call<{ runs: TeamRun[] }>(`/sessions/${session}/team`).then(
      (body) => body.runs,
    ),
  /** A team member's conversation, read-only. */
  teamRun: (session: string, conversation: string) =>
    call<TeamRun & { messages: TranscriptMessage[] }>(
      `/sessions/${session}/team/${conversation}`,
    ),
  profile: () => call<Profile>("/profile"),
  setProfile: (change: { displayName: string | null; bio: string | null }) =>
    call<Profile>("/profile", { method: "PUT", body: JSON.stringify(change) }),
  person: (username: string) =>
    call<Person>(`/people/${encodeURIComponent(username)}`),
  templates: (query: string) =>
    call<{ templates: TemplateSummary[] }>(
      `/templates${query ? `?q=${encodeURIComponent(query)}` : ""}`,
    ).then((body) => body.templates),
  template: (id: string) =>
    call<Template>(`/templates/${encodeURIComponent(id)}`),
  /** Makes a published Pim one of yours: a copy, yours to change. */
  adoptTemplate: (id: string) =>
    call<Persona>(`/templates/${encodeURIComponent(id)}/use`, {
      method: "POST",
    }),
  apps: () =>
    call<{ servers: ConnectedApp[] }>("/mcp").then((body) => body.servers),
  connectApp: (app: SuggestedApp) =>
    call<{ id: string; state: string; authUrl?: string }>("/mcp", {
      method: "POST",
      body: JSON.stringify(app),
    }),
  renameSession: (id: string, title: string) =>
    call<Session>(`/sessions/${id}`, {
      method: "PUT",
      body: JSON.stringify({ title }),
    }),
  deleteSession: (id: string) =>
    call<{ deleted: boolean }>(`/sessions/${id}`, { method: "DELETE" }),
  send: (session: string, content: string) =>
    call<{ operationId: string; accepted: boolean }>(
      `/sessions/${session}/messages`,
      { method: "POST", body: JSON.stringify({ content }) },
    ),
  abort: (session: string) =>
    call<{ aborted: boolean }>(`/sessions/${session}/abort`, {
      method: "POST",
    }),
  approvals: (status?: ApprovalStatus) =>
    call<{ approvals: Approval[] }>(
      `/approvals${status ? `?status=${status}` : ""}`,
    ).then((body) => body.approvals),
  decide: (id: string, decision: "approve" | "deny", always = false) =>
    call<Approval>(`/approvals/${id}/${decision}`, {
      method: "POST",
      body: JSON.stringify(always ? { always } : {}),
    }),
  /** Your own tools' permissions, or a circle's. */
  permissions: (circle?: string) =>
    call<{ tools: ToolPermissionInfo[] }>(
      `/permissions${circle ? `?circle=${encodeURIComponent(circle)}` : ""}`,
    ).then((body) => body.tools),
  setPermission: (
    circle: string | null,
    app: string | null,
    tool: string,
    permission: ToolPermission | null,
  ) =>
    call<ToolPermissionInfo>("/permissions", {
      method: "PUT",
      body: JSON.stringify({ circle, app, tool, permission }),
    }),
  circles: () =>
    call<{ circles: Circle[] }>("/circles").then((body) => body.circles),
  createCircle: (name: string) =>
    call<Circle>("/circles", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  updateCircle: (id: string, change: { name?: string; enabled?: boolean }) =>
    call<Circle>(`/circles/${id}`, {
      method: "PUT",
      body: JSON.stringify(change),
    }),
  deleteCircle: (id: string) =>
    call<{ deleted: boolean }>(`/circles/${id}`, { method: "DELETE" }),
  addMember: (circle: string, username: string) =>
    call<unknown>(`/circles/${circle}/members`, {
      method: "POST",
      body: JSON.stringify({ username }),
    }),
  removeMember: (circle: string, ownerId: string) =>
    call<{ deleted: boolean }>(`/circles/${circle}/members/${ownerId}`, {
      method: "DELETE",
    }),
  guestActivity: () =>
    call<{ activity: GuestActivity[] }>("/circles/activity").then(
      (body) => body.activity,
    ),
  visits: () =>
    call<{ visits: Visit[] }>("/visits").then((body) => body.visits),
  /** Your conversation with a Pim shared with you, started if new. */
  startVisit: (username: string) =>
    call<{ session: string }>(`/visits/${encodeURIComponent(username)}`, {
      method: "POST",
    }),
  notifications: () =>
    call<{ notifications: PimNotification[] }>("/notifications").then(
      (body) => body.notifications,
    ),
  markRead: (id: string) =>
    call<PimNotification>(`/notifications/${id}/read`, { method: "POST" }),
  pushKey: () =>
    call<{ publicKey: string }>("/push/key").then((body) => body.publicKey),
  subscribePush: (subscription: {
    endpoint: string;
    p256dh: string;
    auth: string;
  }) =>
    call<{ subscribed: boolean }>("/push/subscription", {
      method: "PUT",
      body: JSON.stringify(subscription),
    }),
  unsubscribePush: (endpoint: string) =>
    call<{ subscribed: boolean }>("/push/subscription", {
      method: "DELETE",
      body: JSON.stringify({ endpoint }),
    }),
  model: () => call<ModelSettings>("/model"),
  chooseModel: (model: Pick<ModelInfo, "provider" | "id">) =>
    call<{ model: ModelInfo }>("/model", {
      method: "PUT",
      body: JSON.stringify(model),
    }),
  chatgptLogin: () =>
    call<{ url: string }>("/chatgpt/login", { method: "POST" }),
  chatgptCallback: (url: string) =>
    call<ChatGPTStatus>("/chatgpt/callback", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  chatgptLogout: () => call<ChatGPTStatus>("/chatgpt", { method: "DELETE" }),
  email: () => call<EmailState>("/email"),
  startEmail: (address: string) =>
    call<EmailState>("/email", {
      method: "PUT",
      body: JSON.stringify({ address }),
    }),
  confirmEmail: (code: string) =>
    call<EmailState>("/email/confirm", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  removeEmail: () => call<EmailState>("/email", { method: "DELETE" }),
  settings: () => call<PimSettings>("/settings"),
  updateSettings: (
    update: Partial<Omit<PimSettings, "approvalTimeoutSeconds">>,
  ) =>
    call<PimSettings>("/settings", {
      method: "PUT",
      body: JSON.stringify(update),
    }),
  artifacts: () => call<{ artifacts: Artifact[]; bytes: number }>("/artifacts"),
  artifact: (id: string) =>
    call<ArtifactDetail>(`/artifacts/${encodeURIComponent(id)}`),
  artifactVersion: (id: string, version: number) =>
    call<ArtifactVersion>(
      `/artifacts/${encodeURIComponent(id)}/versions/${version}`,
    ),
  restoreArtifact: (id: string, version: number, baseVersion: number) =>
    call<Artifact & { restored: number }>(
      `/artifacts/${encodeURIComponent(id)}/restore`,
      { method: "POST", body: JSON.stringify({ version, baseVersion }) },
    ),
  deleteArtifact: (id: string) =>
    call<{ deleted: boolean }>(`/artifacts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  account: () => call<Account>("/account"),
  /** `deleted: false`: the account is closed, and erasing its data is still being retried. */
  deleteAccount: (username: string) =>
    call<{ deleted: boolean; nextAttemptAt?: string }>("/account", {
      method: "DELETE",
      body: JSON.stringify({ confirm: username }),
    }),
};

const path = (username: string) =>
  `/admin/accounts/${encodeURIComponent(username)}`;

/** Running this Pim: only the admin, signed in with a passkey, may. */
export const admin = {
  members: () =>
    call<{ accounts: Member[] }>("/admin/accounts?limit=500").then(
      (body) => body.accounts,
    ),
  /** A link that lets one person join, once. */
  invite: () =>
    call<{ links: [string] }>("/admin/invites", {
      method: "POST",
      body: JSON.stringify({ count: 1 }),
    }).then((body) => body.links[0]),
  suspend: (username: string) =>
    call(`${path(username)}/suspend`, { method: "POST", body: "{}" }),
  unsuspend: (username: string) =>
    call(`${path(username)}/unsuspend`, { method: "POST", body: "{}" }),
  /** A link that adds a passkey to someone's account, for an hour: for someone who lost every passkey and recovery code. */
  setupLink: (username: string) =>
    call<{ setupUrl: string; expiresAt: string }>(
      `${path(username)}/setup-link`,
      {
        method: "POST",
        body: "{}",
      },
    ),
  remove: (username: string) =>
    call<{ deleted: boolean }>(path(username), {
      method: "DELETE",
      body: "{}",
    }),
  /** The Pim everyone who joins starts with a copy of; null for a plain one. */
  defaultPim: () =>
    call<{ pim: DefaultPim | null }>("/admin/default-pim").then(
      (body) => body.pim,
    ),
  /** Makes a copy of one of the admin's Pims the one everyone who joins starts with; null goes back to a plain one. */
  setDefaultPim: (id: string | null) =>
    call<{ pim: DefaultPim | null }>(
      "/admin/default-pim",
      id === null
        ? { method: "DELETE", body: "{}" }
        : { method: "PUT", body: JSON.stringify({ pim: id }) },
    ).then((body) => body.pim),
};

/** The Pim everyone who joins starts with, as the admin chose it. */
export type DefaultPim = {
  author: string;
  /** Which of the admin's Pims it is a copy of. */
  personaId: string;
  name: string;
  updatedAt: number;
};

/** Where the browser downloads the account's export. */
export const EXPORT_URL = "/api/account/export";
