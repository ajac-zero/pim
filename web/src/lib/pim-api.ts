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
  /** A conversation with someone else's space, shared with you; null for your own chats. */
  visit?: { username: string; available: boolean } | null;
  /** The agent of yours it talks with: the one it was started with, or your default one. Null in a visit. */
  agent?: { id: string; name: string } | null;
};

/**
 * An app people on this Pim can connect: an extension's, or one the admin
 * added (`custom/<app>`). Agents list apps by `ref`; you connect each once,
 * for all your agents.
 */
export type DirectoryApp = {
  ref: string;
  name: string;
  description: string;
  /** Its MCP server; null for an app its extension implements. */
  url: string | null;
  /** Added by the admin, not brought by an extension. */
  custom: boolean;
  /** Its logo, an https or `data:` image URL; null for none. */
  icon: string | null;
  /** Where the Apps page files it; null for Other. */
  category: AppCategory | null;
};

/** The categories apps are filed under, in the order the Apps page shows them (src/extensions/define.ts). */
export const APP_CATEGORIES = [
  "productivity",
  "meetings",
  "development",
  "data",
  "finance",
  "customers",
  "websites",
  "automation",
  "research",
  "media",
] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number];

/** One of an agent's team: it does tasks the agent hands it, and answers the agent, never you. */
export type TeamMember = {
  name: string;
  instructions: string;
  /** The tools it may use, by name; null for all the agent's tools a member can have. */
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

/** Who works on a task, or asked for it: an agent, or a member of an agent's team. */
export type TaskAgent = { id: string; name: string; member: boolean };

/**
 * A task one agent handed another, in a conversation of its own. The tasks a
 * chat led to form a tree by `parent`.
 */
export type AgentTask = {
  id: string;
  /** The task its requester was working on when it handed this one out; null when the chat's agent did. */
  parent: string | null;
  agent: TaskAgent;
  from: TaskAgent;
  task: string;
  state: "working" | "auth-required" | "completed" | "failed" | "canceled";
  /** Its answer, or why it didn't finish, once done. */
  result: string | null;
  createdAt: number;
  updatedAt: number;
};

export type MajordomoState = { agent: Agent; introduced: boolean };

/** How the majordomo talks. */
export const MAJORDOMO_TONES = ["warm", "formal", "playful", "brief"] as const;

/** What you can say you'd like a hand with. */
export const MAJORDOMO_HELP_WITH = [
  "work",
  "home",
  "health",
  "money",
  "learning",
  "travel",
] as const;

/** How much the majordomo handles without asking you. */
export const MAJORDOMO_INVOLVEMENT = [
  "close",
  "balanced",
  "hands_off",
] as const;

export type MajordomoSetup = {
  name: string;
  symbol: string | null;
  color: string | null;
  /** Your name, which it remembers. */
  yourName: string | null;
  tone?: (typeof MAJORDOMO_TONES)[number] | null;
  /** How it should talk, in your words, instead of or besides `tone`. */
  customTone?: string | null;
  /** What you'd like a hand with, which it remembers. */
  helpWith?: (typeof MAJORDOMO_HELP_WITH)[number][];
  /** Anything else you'd like a hand with, in your words: a few things at most. */
  otherHelp?: string[];
  involvement?: (typeof MAJORDOMO_INVOLVEMENT)[number] | null;
  /** The language your app is in, for its introduction. */
  locale: string;
  /** The title of the chat it opens. */
  title?: string;
};

/** How long an agent's name may be. */
export const MAX_PIM_NAME = 60;

/** One of your agents: its own name and instructions, on top of a blueprint. */
export type Agent = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  /** The apps it works with, by `ref`: its chats get only these apps' tools. */
  apps: string[];
  /** The names of your skills it uses. */
  skills: string[];
  team: TeamMember[];
  /** The blueprint it builds on, as `<extension>/<blueprint>`, which brings its dashboard; null for none. */
  blueprint: string | null;
  /** The template it was made from. */
  source: { template: string; author: string } | null;
  /** Its template in the gallery, while published. */
  published: string | null;
  /** When its icon was set, or null without one. */
  icon: number | null;
  /** What shows without an uploaded icon: a named icon, such as `rocket`, or one emoji; null for the default. */
  symbol: string | null;
  /** The color of its symbol, such as `teal`; null for the default. */
  color: string | null;
  /** Your majordomo: the one that talks in chats started without choosing an agent. There is one, always the same, and it can't be deleted. */
  majordomo: boolean;
  createdAt: number;
  updatedAt: number;
};

/** Where a widget's item leads. */
export type WidgetLink = { chat: string } | { artifact: string; chat?: string };

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

/** Text from an extension: one string, or one per language with English always there. */
export type ExtensionText = string | ({ en: string } & Record<string, string>);

/** What a widget shows, in a kind the app draws, or that it failed to load. */
export type WidgetContent =
  | { kind: "list"; items: WidgetListItem[] }
  | { kind: "progress"; items: WidgetProgressItem[] }
  | { failed: true };

/** A widget as kept with a message: its text in every language the extension gave it. */
export type ShownWidget = {
  id: string;
  title: ExtensionText;
  empty: ExtensionText;
} & WidgetContent;

/** One card of a dashboard, loaded by the extension that brings it, in the kind the app draws. */
export type Widget = {
  id: string;
  title: string;
  empty: string;
} & WidgetContent;

export type Dashboard = {
  agent: Pick<
    Agent,
    | "id"
    | "name"
    | "description"
    | "majordomo"
    | "blueprint"
    | "icon"
    | "symbol"
    | "color"
  >;
  /** Messages to start a chat with. */
  starters: string[];
  widgets: Widget[];
};

export type AgentInput = {
  name: string;
  description: string;
  instructions: string;
  apps: string[];
  skills?: string[];
  team: TeamMember[];
  /** Left out, a new agent is based on the deployment's default blueprint. */
  blueprint?: string | null;
  /** Left out, a new agent has the default look and an edited one keeps its own. */
  symbol?: string | null;
  color?: string | null;
};

/** What this deployment installed: the blueprints people's agents can be based on, and widgets. */
export type InstalledExtension = {
  id: string;
  name: string;
  description: string;
  blueprints: {
    ref: string;
    name: string;
    description: string;
    /** The apps agents based on this blueprint work with, besides their own, by `ref`. */
    apps: string[];
  }[];
  widgets: string[];
};

export type Extensions = {
  extensions: InstalledExtension[];
  /** What new agents are based on when not told otherwise. */
  defaultBlueprint: string | null;
};

/** An agent someone published for others to make their own. */
export type Template = {
  id: string;
  author: string;
  authorName: string | null;
  name: string;
  description: string;
  instructions: string;
  apps: string[];
  team: TeamMember[];
  /** Its look, as the agent's was when published. */
  symbol: string | null;
  color: string | null;
  /** When its uploaded icon was published, or null without one. */
  icon: number | null;
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
  /** The directory's app it connects, by `ref`; null for one this Pim no longer offers. */
  app: string | null;
  name: string;
  url: string;
  /** `ready`, `authenticating` (waiting for you to sign in), `failed`, or on its way. */
  state: string;
  error: string | null;
  /** Where to sign in, while it waits for you to. */
  authUrl: string | null;
  /** Your agents that work with it: only their chats get its tools. */
  agents: string[];
  tools: { name: string }[];
};

export type ApprovalStatus = "pending" | "approved" | "denied";

export type Approval = {
  id: string;
  /** The chat that asked; null when a guest asked, from their own space. */
  session: string | null;
  action: string;
  /** The tool "always approve" remembers; null for explicit-only or older requests. */
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
  /** Who decided: the user, the timeout, "always approve", or the majordomo for the user. */
  decidedBy?: "user" | "timeout" | "always" | "majordomo" | null;
  /** Someone in one of your circles asked, from their own space; null when your space asked. */
  requestedBy?: {
    ownerId: string;
    username: string;
    circle: string;
    circleName: string;
  } | null;
  /** An agent at work on a task asked, for the chat `session` names; the approval's own `session` is the task's conversation. */
  member?: { name: string; session: string } | null;
  /** The majordomo has it first: deciding, or it asked you, with what it said. Null when you were asked directly. */
  review?: {
    status: "reviewing" | "escalated";
    note: string | null;
  } | null;
};

/** One of your circles: people who may message your space, and what they may use. */
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

/** Someone else's space, shared with you. */
export type Visit = {
  ownerId: string;
  username: string;
  sharedAt: number;
  /** False once they took it back. */
  available: boolean;
  /** Your conversation with it, once started. */
  session: string | null;
};

export type ApprovalPolicy = "majordomo" | "auto" | "explicit";

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
  storageBytes: number | null;
  artifacts: number | null;
  artifactVersions: number | null;
  artifactBytes: number | null;
  artifactStorageBytes: number | null;
};

/** How this deployment runs for everyone, from its variables. */
export type DeploymentSettings = {
  registration: "invite" | "open" | "closed";
  /** Null: no cap. */
  maxAccounts: number | null;
  registrationsPerAddress: number;
  /** For anyone who hasn't chosen their own. */
  approvalPolicy: ApprovalPolicy;
  timeZone: string;
  model: string;
  /** Empty: any model. */
  models: string[];
  /** Null: side jobs are off. */
  utilityModel: string | null;
  /** Null: the default model. */
  memoryModel: string | null;
  memoryLines: number;
  webSearch: "exa" | "ceramic" | "linkup" | null;
  /** Members' limits; null for none. */
  limits: Limits;
  /** Null: learned from requests. */
  publicUrl: string | null;
  /** Null: no public artifact links. */
  contentOrigin: string | null;
  /** Null: no email. */
  emailFrom: string | null;
};

/** One of the deployment's variables: as set (null when it isn't), and why Pim can't read it, if it can't. */
export type DeploymentVariable = {
  name: string;
  value: string | null;
  problem: string | null;
};

export const ARTIFACT_KINDS = [
  "html",
  "markdown",
  "svg",
  "mermaid",
  "jsx",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** An artifact, as its latest version. */
export type Artifact = {
  id: string;
  title: string;
  kind: ArtifactKind;
  session: string | null;
  version: number;
  versions: number;
  /** The latest version's size: all its files. */
  size: number;
  /** How many files the latest version has. */
  files: number;
  sha256: string;
  createdAt: number;
  updatedAt: number;
};

/** One file of a version. */
export type ArtifactFile = {
  path: string;
  sha256: string;
  size: number;
  type: string;
};

export type ArtifactVersionInfo = {
  version: number;
  sha256: string;
  size: number;
  /** "person": the person edited it; "restore": they restored `restoredFrom`. */
  source: "agent" | "person" | "restore";
  restoredFrom: number | null;
  createdAt: number;
};

export type ArtifactDetail = Artifact & {
  history: ArtifactVersionInfo[];
  /** The circles it's shared with, whose people see its latest version. */
  circles: string[];
};

/** An artifact someone shared with you: its latest version, from their Pim. */
export type SharedArtifact = Omit<Artifact, "session"> & {
  /** Whose it is: their username. */
  host: string;
};

/** An artifact someone published for everyone on this Pim: a copy of one of its versions. */
export type PublishedArtifact = {
  id: string;
  author: string;
  authorName: string | null;
  /** Which of the author's artifacts it copies, and which version. */
  artifactId: string;
  version: number;
  title: string;
  kind: ArtifactKind;
  sha256: string;
  size: number;
  publishedAt: number;
  /** How many people made it their own. */
  uses: number;
  /** Whether anyone with its link may see it, without an account. */
  public: boolean;
};

/** What you published of one of your artifacts, with its public link if it has one, and whether it can. */
export type ArtifactPublication = PublishedArtifact & {
  linkable: boolean;
  link: string | null;
};

export type ArtifactVersion = ArtifactVersionInfo & {
  id: string;
  title: string;
  kind: ArtifactKind;
  latest: number;
  /** The files it has, its main file among them. */
  files: ArtifactFile[];
  /** The file `content` is, its main file unless another was asked for. */
  path: string;
  /** That file's text; null when it isn't text. */
  content: string | null;
};

/** One version of a skill, without its text. */
export type SkillVersionInfo = {
  version: number;
  /** The agent that wrote it, by name then; null for a version you restored. */
  author: string | null;
  /** The version a restore copied. */
  restoredFrom: number | null;
  createdAt: number;
};

export type SkillVersion = SkillVersionInfo & {
  name: string;
  description: string;
  instructions: string;
  /** Supporting files, by their paths relative to the skill. */
  files: { path: string; content: string }[];
};

/** A skill your agents wrote, as its latest version, and the agents that use it. */
export type Skill = Omit<SkillVersion, "instructions" | "files"> & {
  updatedAt: number;
  agents: { id: string; name: string }[];
};

export type SkillDetail = Skill & {
  instructions: string;
  files: SkillVersion["files"];
  /** The versions kept, newest first. */
  history: SkillVersionInfo[];
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

/** Whose an artifact is, when it isn't yours: one `host` (their username) shares with you, or one published to everyone. */
export type ArtifactFrom = { host: string } | { published: true };

/** Where an artifact is in the API. */
const artifactRoot = (id: string, from?: ArtifactFrom) =>
  !from
    ? `/artifacts/${encodeURIComponent(id)}`
    : "host" in from
      ? `/shared-artifacts/${encodeURIComponent(from.host)}/${encodeURIComponent(id)}`
      : `/published-artifacts/${encodeURIComponent(id)}`;

const artifactPath = (id: string, version: number, from?: ArtifactFrom) =>
  `/api${artifactRoot(id, from)}/versions/${version}`;

/** The sandboxed page a framed artifact's version is shown in. */
export const artifactFrameUrl = (
  id: string,
  version: number,
  from?: ArtifactFrom,
) => `${artifactPath(id, version, from)}/frame`;

/** Where the browser downloads a version's file: its main one, unless `path` names another. */
export const artifactDownloadUrl = (
  id: string,
  version: number,
  path?: string,
) =>
  `${artifactPath(id, version)}/download${path ? `?path=${encodeURIComponent(path)}` : ""}`;

/** A file or folder in your files, which you and your agents share. */
export type FileEntry = {
  name: string;
  /** Absolute, under `FILES_ROOT`. */
  path: string;
  type: "file" | "directory";
  size: number;
  updatedAt: string;
};

/** The folder that holds your files; the agents see it at this path. */
export const FILES_ROOT = "/workspace";

/** Where the browser opens a file's bytes, or downloads them. */
export const fileContentUrl = (path: string, download = false) =>
  `/api/files/content?path=${encodeURIComponent(path)}${download ? "&download" : ""}`;

/** The browser your agents share: whether this Pim has one, and the page it shows when it's open. */
export type BrowserStatus = {
  available: boolean;
  page: { url: string; title: string } | null;
};

/** A picture of the page the browser shows. */
export const BROWSER_SCREENSHOT_URL = "/api/browser/screenshot";

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
  /** Nobody else has an active account on this Pim, so there is nobody to share with. */
  alone: boolean;
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

/** Work Pim scheduled for itself: once, or repeating on a cron in UTC. */
export type PimSchedule = {
  id: string;
  type: "scheduled" | "delayed" | "cron" | "interval";
  /** When it runs next, as an ISO date. */
  next: string;
  cron?: string;
  intervalSeconds?: number;
  /** The chat that scheduled it: where it runs, unless it starts a new chat each time. */
  session: string;
  label: string | null;
  instruction: string;
  /** Each run starts a new chat with the same agent; it outlives the chat that scheduled it. */
  newChat: boolean;
};

export type ModelInfo = {
  provider: string;
  id: string;
  name: string;
  /** It can see images sent with a message. */
  images: boolean;
};

/** What a person sends: text, or text and images (base64, with their type). */
export type UserContent =
  | string
  | (
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    )[];

export type ChatGPTStatus = { connected: boolean; email: string | null };

export type ModelSettings = {
  /** The model every session uses. */
  model: ModelInfo;
  /** The deployment's own model, used when nothing else is chosen. */
  default: ModelInfo;
  choices: ModelInfo[];
  /** The utility model, for side jobs: naming chats, improving prompts, summarizing. Null when there is none. */
  utility: {
    model: ModelInfo | null;
    default: ModelInfo | null;
    choices: ModelInfo[];
  };
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
  | { type: "sessions" }
  | { type: "tasks"; session: string }
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

/** The deployment hasn't set `PIM_PUBLIC_URL`, so Pim answers nothing yet. */
export class NoAddress extends Error {}

/**
 * Pim answers only at its own address: one opened at another goes there,
 * and one without an address yet throws `NoAddress`.
 */
export function checkAddress(
  response: Response,
  body: { url?: unknown; missing?: unknown; error?: string } | null,
) {
  if (response.status === 421 && typeof body?.url === "string") {
    const { pathname, search, hash } = window.location;
    window.location.replace(new URL(pathname + search + hash, body.url));
  }
  if (response.status === 503 && body?.missing === "PIM_PUBLIC_URL") {
    throw new NoAddress(body.error);
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
    | (T & { error?: string; url?: unknown; missing?: unknown })
    | null;
  if (!response.ok) {
    checkAddress(response, body);
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
  createSession: (options: { title?: string; agent?: string } = {}) =>
    call<Session>("/sessions", {
      method: "POST",
      body: JSON.stringify(options),
    }),
  agents: () =>
    call<{ agents: Agent[] }>("/agents").then((body) => body.agents),
  createAgent: (input: AgentInput) =>
    call<Agent>("/agents", { method: "POST", body: JSON.stringify(input) }),
  updateAgent: (id: string, input: Partial<AgentInput>) =>
    call<Agent>(`/agents/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  setAgentIcon: async (id: string, icon: Blob) => {
    const response = await fetch(`/api/agents/${id}/icon`, {
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
  files: (path: string) =>
    call<{ path: string; entries: FileEntry[] }>(
      `/files?path=${encodeURIComponent(path)}`,
    ),
  /** Saves a file at `path`, replacing one already there. */
  uploadFile: async (path: string, file: Blob) => {
    const response = await fetch(
      `/api/files/content?path=${encodeURIComponent(path)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      },
    );
    const body = (await response.json().catch(() => null)) as
      | (FileEntry & { error?: string })
      | null;
    if (!response.ok) {
      throw new ApiError(
        response.status,
        body?.error ?? `Pim answered ${response.status}`,
      );
    }
    return body as FileEntry;
  },
  /** Deletes a file, or a folder with everything in it. */
  deleteFile: (path: string) =>
    call<{ deleted: boolean }>(`/files?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    }),
  browser: () => call<BrowserStatus>("/browser"),
  /** A Live View link to use the browser yourself; it carries its own access. */
  takeOverBrowser: () =>
    call<{ url: string }>("/browser/live", { method: "POST" }),
  closeBrowser: () =>
    call<{ closed: boolean }>("/browser", { method: "DELETE" }),
  removeAgentIcon: (id: string) =>
    call<Agent>(`/agents/${id}/icon`, { method: "DELETE" }),
  deleteAgent: (id: string) =>
    call<{ deleted: boolean }>(`/agents/${id}`, { method: "DELETE" }),
  extensions: () => call<Extensions>("/extensions"),
  /** Your majordomo, and whether you named it yet. */
  majordomo: () => call<MajordomoState>("/majordomo"),
  /** Names your majordomo, once, and has it open your first chat, whose id it returns. */
  setUpMajordomo: (setup: MajordomoSetup) =>
    call<MajordomoState & { session: string }>("/majordomo", {
      method: "POST",
      body: JSON.stringify(setup),
    }),
  /** An agent's dashboard, with its text in `locale` where the extensions translated it. */
  dashboard: (id: string, locale: string) =>
    call<Dashboard>(
      `/agents/${id}/dashboard?locale=${encodeURIComponent(locale)}`,
    ),
  publishAgent: (id: string) =>
    call<Template>(`/agents/${id}/publish`, { method: "POST" }),
  unpublishAgent: (id: string) =>
    call<{ deleted: boolean }>(`/agents/${id}/publish`, { method: "DELETE" }),
  /** The tasks a chat led to, oldest first. */
  tasks: (session: string) =>
    call<{ tasks: AgentTask[] }>(`/sessions/${session}/tasks`).then(
      (body) => body.tasks,
    ),
  /** A task's conversation, read-only. */
  task: (session: string, id: string) =>
    call<AgentTask & { messages: TranscriptMessage[] }>(
      `/sessions/${session}/tasks/${id}`,
    ),
  cancelTask: (session: string, id: string) =>
    call<AgentTask>(`/sessions/${session}/tasks/${id}/cancel`, {
      method: "POST",
    }),
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
  /** Makes a published agent one of yours: a copy, yours to change. */
  adoptTemplate: (id: string) =>
    call<Agent>(`/templates/${encodeURIComponent(id)}/use`, {
      method: "POST",
    }),
  apps: () =>
    call<{ servers: ConnectedApp[] }>("/mcp").then((body) => body.servers),
  /** The apps you can connect. */
  appDirectory: () =>
    call<{ apps: DirectoryApp[] }>("/app-directory").then((body) => body.apps),
  connectApp: (ref: string) =>
    call<{ id: string; state: string; authUrl?: string }>("/mcp", {
      method: "POST",
      body: JSON.stringify({ app: ref }),
    }),
  removeApp: (id: string) =>
    call<{ deleted: boolean }>(`/mcp/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  renameSession: (id: string, title: string) =>
    call<Session>(`/sessions/${id}`, {
      method: "PUT",
      body: JSON.stringify({ title }),
    }),
  deleteSession: (id: string) =>
    call<{ deleted: boolean }>(`/sessions/${id}`, { method: "DELETE" }),
  // Side jobs on the utility model.
  regenerateTitle: (id: string) =>
    call<Session>(`/sessions/${id}/title`, { method: "POST" }),
  summary: (id: string) =>
    call<{ summary: string | null }>(`/sessions/${id}/summary`).then(
      (body) => body.summary,
    ),
  improvePrompt: (text: string) =>
    call<{ text: string }>("/prompts/improve", {
      method: "POST",
      body: JSON.stringify({ text }),
    }).then((body) => body.text),
  send: (session: string, content: UserContent) =>
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
  /** Your conversation with a space shared with you, started if new. */
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
  schedules: () =>
    call<{ schedules: PimSchedule[] }>("/schedules").then(
      (body) => body.schedules,
    ),
  cancelSchedule: (id: string) =>
    call<{ deleted: boolean }>(`/schedules/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
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
  chooseUtilityModel: (model: Pick<ModelInfo, "provider" | "id">) =>
    call<{ model: ModelInfo | null }>("/model/utility", {
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
  /** A version, with the text of its main file, or of the file at `path`. */
  artifactVersion: (
    id: string,
    version: number,
    from?: ArtifactFrom,
    path?: string,
  ) =>
    call<ArtifactVersion>(
      `${artifactRoot(id, from)}/versions/${version}${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
  sharedArtifacts: () =>
    call<{ artifacts: SharedArtifact[] }>("/shared-artifacts"),
  sharedArtifact: (host: string, id: string) =>
    call<SharedArtifact>(artifactRoot(id, { host })),
  publishedArtifacts: (query = "") =>
    call<{ artifacts: PublishedArtifact[] }>(
      `/published-artifacts${query ? `?q=${encodeURIComponent(query)}` : ""}`,
    ).then((body) => body.artifacts),
  publishedArtifact: (id: string) =>
    call<PublishedArtifact>(artifactRoot(id, { published: true })),
  /** What you published of one of your artifacts; null when you haven't. */
  artifactPublication: (id: string) =>
    call<ArtifactPublication>(
      `/artifacts/${encodeURIComponent(id)}/publish`,
    ).catch((failure) => {
      if (failure instanceof ApiError && failure.status === 404) return null;
      throw failure;
    }),
  /** Publishes the latest version; `open` also lets anyone with the link see it, or stops them. */
  publishArtifact: (id: string, open?: boolean) =>
    call<ArtifactPublication>(`/artifacts/${encodeURIComponent(id)}/publish`, {
      method: "POST",
      body: JSON.stringify(open === undefined ? {} : { public: open }),
    }),
  unpublishArtifact: (id: string) =>
    call<{ deleted: boolean }>(`/artifacts/${encodeURIComponent(id)}/publish`, {
      method: "DELETE",
    }),
  /** Makes a published artifact one of yours. */
  adoptArtifact: (id: string) =>
    call<Artifact>(`${artifactRoot(id, { published: true })}/use`, {
      method: "POST",
    }),

  setArtifactCircles: (id: string, circles: string[]) =>
    call<ArtifactDetail>(`/artifacts/${encodeURIComponent(id)}/circles`, {
      method: "PUT",
      body: JSON.stringify({ circles }),
    }),
  restoreArtifact: (id: string, version: number, baseVersion: number) =>
    call<Artifact & { restored: number }>(
      `/artifacts/${encodeURIComponent(id)}/restore`,
      { method: "POST", body: JSON.stringify({ version, baseVersion }) },
    ),
  /** Saves new content for one file (the main one, unless `path` names another) as a new version. */
  saveArtifact: (
    id: string,
    baseVersion: number,
    content: string,
    path?: string,
  ) =>
    call<Artifact & { saved: number; changed: boolean }>(
      `/artifacts/${encodeURIComponent(id)}/versions`,
      {
        method: "POST",
        body: JSON.stringify({
          baseVersion,
          content,
          ...(path ? { path } : {}),
        }),
      },
    ),
  /** One call an artifact made through its bridge: its answer, or what the person must allow first. */
  artifactBridge: (
    id: string,
    version: number,
    op: string,
    args: unknown,
    from?: ArtifactFrom,
  ) =>
    call<{ value: unknown } | { needs: { capability: string; label: string } }>(
      `${artifactRoot(id, from)}/versions/${version}/bridge`,
      { method: "POST", body: JSON.stringify({ op, args }) },
    ),
  grantArtifact: (
    id: string,
    version: number,
    capability: string,
    from?: ArtifactFrom,
  ) =>
    call<{ granted: string }>(
      `${artifactRoot(id, from)}/versions/${version}/grants`,
      { method: "POST", body: JSON.stringify({ capability }) },
    ),
  deleteArtifact: (id: string) =>
    call<{ deleted: boolean }>(`/artifacts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  skills: () =>
    call<{ skills: Skill[] }>("/skills").then((body) => body.skills),
  skill: (name: string) =>
    call<SkillDetail>(`/skills/${encodeURIComponent(name)}`),
  skillVersion: (name: string, version: number) =>
    call<SkillVersion>(
      `/skills/${encodeURIComponent(name)}/versions/${version}`,
    ),
  restoreSkill: (name: string, version: number, baseVersion: number) =>
    call<SkillDetail>(`/skills/${encodeURIComponent(name)}/restore`, {
      method: "POST",
      body: JSON.stringify({ version, baseVersion }),
    }),
  deleteSkill: (name: string) =>
    call<{ deleted: string }>(`/skills/${encodeURIComponent(name)}`, {
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
/** A sign-in provider as the admin's settings show it: never its secrets' values. */
export type SignInProviderSettings = {
  id: "google" | "github" | "oidc";
  name: string;
  /** The deployment's secrets turn it on. */
  enabled: boolean;
  /** Which of those secrets are missing, when only some are set. */
  problem: string | null;
  /** The secrets that turn it on. */
  secrets: string[];
  /** Where the provider must send people back to. */
  callbackUrl: string;
};

export const admin = {
  /** Takes a published artifact down, for everyone. */
  removePublishedArtifact: (id: string) =>
    call<{ deleted: boolean }>(
      `/admin/published-artifacts/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  /** Google, GitHub and a custom single sign-on provider, and which the deployment turns on. */
  signInProviders: () =>
    call<{ providers: SignInProviderSettings[] }>("/admin/sign-in").then(
      (body) => body.providers,
    ),
  /** How this deployment runs, and the variables that say so. */
  deployment: () =>
    call<{ settings: DeploymentSettings; variables: DeploymentVariable[] }>(
      "/admin/deployment",
    ),
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
  /** The agent everyone who joins starts with a copy of; null for a plain one. */
  defaultAgent: () =>
    call<{ agent: DefaultAgent | null }>("/admin/default-agent").then(
      (body) => body.agent,
    ),
  /** Makes a copy of one of the admin's agents the one everyone who joins starts with; null goes back to a plain one. */
  setDefaultAgent: (id: string | null) =>
    call<{ agent: DefaultAgent | null }>(
      "/admin/default-agent",
      id === null
        ? { method: "DELETE", body: "{}" }
        : { method: "PUT", body: JSON.stringify({ agent: id }) },
    ).then((body) => body.agent),
  /** Adds an app everyone on this Pim can connect: a remote MCP server. */
  addApp: (app: {
    name: string;
    description: string;
    url: string;
    icon: string;
    category: AppCategory | "";
  }) =>
    call<{ app: { id: string } }>("/admin/apps", {
      method: "POST",
      body: JSON.stringify(app),
    }),
  /** Gives an app the admin added another icon, by its id; an empty one looks its site's up again. */
  setAppIcon: (id: string, icon: string) =>
    call<{ app: { id: string } }>(`/admin/apps/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ icon }),
    }),
  /** Takes an app the admin added out of the directory, by its id (`custom/<id>`). */
  removeApp: (id: string) =>
    call<{ deleted: boolean }>(`/admin/apps/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: "{}",
    }),
};

/** The agent everyone who joins starts with, as the admin chose it. */
export type DefaultAgent = {
  author: string;
  /** Which of the admin's agents it is a copy of. */
  agentId: string;
  name: string;
  updatedAt: number;
};

/** Where the browser downloads the account's export. */
export const EXPORT_URL = "/api/account/export";
