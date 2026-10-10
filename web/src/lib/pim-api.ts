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
};

export type ApprovalPolicy = "auto" | "explicit";

export type PimSettings = {
  timeZone: string;
  approvalPolicy: ApprovalPolicy;
  approvalTimeoutSeconds: number;
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

/** A hosted Pimling's account. */
export type Account = {
  username: string;
  ownerId: string;
  status: "active" | "pending" | "suspended";
  createdAt: number;
  url: string;
  usage: UsageReport;
  recoveryCodesLeft: number;
};

/** A tool whose calls are approved without asking. */
export type AlwaysApproved = { tool: string; createdAt: number };

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
  createSession: (title?: string) =>
    call<Session>("/sessions", {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
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
  alwaysApproved: () =>
    call<{ tools: AlwaysApproved[] }>("/always-approved").then(
      (body) => body.tools,
    ),
  stopAlwaysApproving: (tool: string) =>
    call<{ deleted: boolean }>(`/always-approved/${encodeURIComponent(tool)}`, {
      method: "DELETE",
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
  /** Pimling only: a self-hosted Pim has no account and answers 404, so this is null. */
  account: () =>
    call<Account>("/account").catch((error) => {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }),
  /** `deleted: false`: the account is closed, and erasing its data is still being retried. */
  deleteAccount: (username: string) =>
    call<{ deleted: boolean; nextAttemptAt?: string }>("/account", {
      method: "DELETE",
      body: JSON.stringify({ confirm: username }),
    }),
};

/** Where the browser downloads the account's export. */
export const EXPORT_URL = "/api/account/export";
