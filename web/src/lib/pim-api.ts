import type { AgentEvent } from "@earendil-works/pi-durable";

/**
 * Pim's REST API, reached through this app's own `/api` path: the app's
 * Worker forwards it to Pim and adds the API token, so the browser never
 * holds it. Shapes follow the API in docs/reference.md.
 */

export type Session = {
  id: string;
  title: string | null;
  busy: boolean;
  /** Its run waits for you to try again after a model error: not at work. */
  held?: boolean;
  createdAt: number | null;
  updatedAt: number | null;
  responseAt: number | null;
  unread: boolean;
  /** Archived by hand, or two weeks without activity with nothing unread or running: listed apart until it is active again. */
  archived?: boolean;
  /** A conversation with someone else's space, shared with you; null for your own chats. */
  visit?: { username: string; available: boolean } | null;
  /** The agent of yours it talks with: the one it was started with, or your default one. Null in a visit. */
  agent?: { id: string; name: string } | null;
  /**
   * A group chat: how its agents take turns, and the agents in it besides
   * `agent`, its host, each with whether it is at work. Null for a chat with
   * one agent.
   */
  room?: Room | null;
  /** Another of your agents started it to hand its agent a task: who, from which chat, and how the task is going. Null for chats you started. */
  startedBy?: StartedBy | null;
  /** The chat it carries on, which grew too long to go on in: the sidebar lists it under that chat. Null for chats you started fresh. */
  continuedFrom?: string | null;
};

export type StartedBy = {
  /** The chat it was started from, which the sidebar lists it under. */
  session: string;
  agent: { id: string; name: string };
  task: string;
  state: AgentTask["state"];
};

/** How a group chat's agents take turns: `mentions`, answering when mentioned; `open`, each deciding for itself. */
export type RoomMode = "mentions" | "open";

export type Room = {
  mode: RoomMode;
  /** `held`: its run waits for a Try again after a model error, which `error` says. */
  members: {
    id: string;
    name: string;
    busy: boolean;
    held: boolean;
    error: string | null;
  }[];
};

/**
 * A connector people on this Pim can connect: an extension's, or one the admin
 * added (`custom/<connector>`). Agents list connectors by `ref`; you connect each once,
 * for all your agents.
 */
export type DirectoryApp = {
  ref: string;
  name: string;
  description: string;
  /** Its MCP server; null for a connector its extension implements. */
  url: string | null;
  /** Added by the admin, not brought by an extension. */
  custom: boolean;
  /** Its logo, an https or `data:` image URL; null for none. */
  icon: string | null;
  /** Where the Connectors page files it; null for Other. */
  category: AppCategory | null;
  /** Its page for you once you've connected it, such as Drive's file picker, and what its button says. */
  page?: { url: string; label: ExtensionText };
};

/** The categories connectors are filed under, in the order the Connectors page shows them (src/extensions/define.ts). */
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

/** Another agent that comes with a template: one of its contacts, or of theirs. */
export type BundledAgent = {
  name: string;
  description: string;
  instructions: string;
  apps: string[];
  symbol: string | null;
  color: string | null;
  /** Its contacts, by name, among the agents that come with the template. */
  contacts: string[];
  /** When its uploaded icon was published, or null without one. */
  icon: number | null;
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

/** Who works on a task, or asked for it: one of your agents. */
export type TaskAgent = { id: string; name: string };

/**
 * A task one agent handed another, in a conversation of its own. The tasks a
 * chat led to form a tree by `parent`.
 */
export type AgentTask = {
  id: string;
  /** The task its requester was working on when it handed this one out; null when the chat's agent did. */
  parent: string | null;
  /** The id of the `delegate` call that handed it out, in its requester's transcript; null for tasks from before it was kept. */
  call: string | null;
  /** The chat it runs in, which opens like any other; null for tasks from before tasks were chats, which open read-only beside the chat. */
  session: string | null;
  agent: TaskAgent;
  from: TaskAgent;
  task: string;
  state: "working" | "auth-required" | "completed" | "failed" | "canceled";
  /** Its answer, or why it didn't finish, once done. */
  result: string | null;
  createdAt: number;
  updatedAt: number;
};

export type MajordomoState = {
  agent: Agent;
  introduced: boolean;
  /** How it talks and how much it handles on its own, read from its instructions. */
  preferences: MajordomoPreferences;
  /** Your name, as you gave it when you joined or as an account you linked says it; agents can mention you by it. */
  yourName: string | null;
};

/** How the majordomo talks with you and how much it handles on its own, as its page sets them. */
export type MajordomoPreferences = {
  tone: (typeof MAJORDOMO_TONES)[number] | null;
  /** How it should talk, in your words. */
  customTone: string | null;
  involvement: (typeof MAJORDOMO_INVOLVEMENT)[number] | null;
};

/** How the majordomo talks. */
export const MAJORDOMO_TONES = ["warm", "formal", "playful", "brief"] as const;

/** How much the majordomo handles without asking you. */
export const MAJORDOMO_INVOLVEMENT = [
  "close",
  "balanced",
  "hands_off",
] as const;

/** How your first chat starts, as the app gives it. */
export type MajordomoStart = {
  /** Your name, when the account you joined with says it; it remembers. */
  yourName: string | null;
  /** The language your app is in, for its introduction. */
  locale: string;
  /** The title of the chat it opens. */
  title: string;
};

/** A memory scope, the agents that read it, and how much it holds. */
export type MemoryScopeInfo = {
  key: string;
  kind: "private" | "everyone" | "agent" | "named" | "former";
  name: string | null;
  agents: string[];
  readers: string[];
  count: number;
};

export type MemoryEntry = {
  id: number;
  date: string;
  text: string;
  forgotten: boolean;
  source: string | null;
  scope: string;
};

/** One of your agents: its own name and instructions, on top of Pim's assistant. */
export type Agent = {
  memoryScope: string;
  memoryScopes: string[];
  id: string;
  /** What people call it, such as Ada. Each agent has a name of its own. */
  name: string;
  /** What it is for, such as Researcher: each of your agents has its own. */
  role: string;
  description: string;
  instructions: string;
  /** The connectors it works with, by `ref`: its chats get only these connectors' tools. */
  apps: string[];
  /** The names of your skills it uses. */
  skills: string[];
  /** Your other agents it hands tasks to, by id; your majordomo's is empty, as it hands tasks to all of them. */
  contacts: string[];
  /** The model it runs on; null follows the default model (Settings → Model). */
  model: { provider: string; id: string } | null;
  /** The models it moves on to, in order, when its own fails for good, such as when its quota runs out. */
  fallbacks: { provider: string; id: string }[];
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

/** A chat's public link, as its owner sees it: `messages` counts what the copy holds, as of `sharedAt`. */
export type SessionCost = {
  total: number;
  models: {
    provider: string;
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  }[];
};

export type ChatLink = {
  id: string;
  url: string;
  sharedAt: number;
  messages: number;
};

/** What a chat's public link shows: a copy of the chat as it was when the link was made or last updated (src/chat-links.ts). */
export type SharedChat = {
  title: string | null;
  agent: { name: string; symbol: string | null; color: string | null };
  sharedAt: number;
  messages: (
    | { role: "user"; text: string; images: number; at: number }
    | {
        role: "agent";
        text: string;
        widgets: ShownWidget[];
        at: number;
        /** In a group chat, another agent than the chat's own. */
        from?: string;
      }
  )[];
};

/** A widget's card, loaded by the extension that brings it, in the kind the app draws, with its text in one language. */
export type Widget = {
  id: string;
  title: string;
  empty: string;
} & WidgetContent;

export type AgentInput = {
  memoryScopes?: string[];
  name: string;
  /** Left out, a new agent's role is its name and an edited one keeps its own. */
  role?: string;
  description: string;
  instructions: string;
  apps: string[];
  skills?: string[];
  contacts: string[];
  /** Left out, a new agent has the default look and an edited one keeps its own. */
  symbol?: string | null;
  color?: string | null;
};

/** What this deployment installed: its extensions and their widgets. */
export type InstalledExtension = {
  id: string;
  name: string;
  description: string;
  widgets: string[];
};

export type Extensions = {
  extensions: InstalledExtension[];
  /** The logo at the top of the sidebar (`logo` in `pim.config.ts`); null for Pim's own mark. */
  logo: string | null;
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
  /** Its contacts, by name, among `bundle`. */
  contacts: string[];
  /** The other agents that come with it: its contacts, and theirs. */
  bundle: BundledAgent[];
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

/** A connector, as Pim lists them. */
export type ConnectedApp = {
  id: string;
  /** The directory's connector it connects, by `ref`; null for one this Pim no longer offers. */
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
    /** A guest of one of your bots asked, through it: `circleName` is then the bot's name. */
    bot?: string;
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
  memoryScopes: string[];
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

/** Which messages alert the devices: those that need you, or every one. */
export type DeviceAlerts = "important" | "all";

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
  deviceAlerts: DeviceAlerts;
  /** Null: approvals wait for an answer however long. */
  approvalTimeoutSeconds: number | null;
};

export type Limits = {
  dailyTokens: number | null;
  dailyModelRequests: number | null;
  dailyRuns: number | null;
  dailyToolCalls: number | null;
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
  /** Null: agents can't make images. */
  imageModel: string | null;
  /** Members' limits; null for none. */
  limits: Limits;
  /** Null: learned from requests. */
  publicUrl: string | null;
  /** Null: no public app links. */
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
  "hosted",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** How an app's backend, which runs on your computer, is doing. */
export type BackendState =
  | "starting"
  | "running"
  | "crashed"
  | "failed"
  | "stopped";

export type ArtifactBackend = {
  /** The version run last; null for one never run. */
  version: number | null;
  /** What the computer says; null while it can't say: offline, or never run. */
  status: {
    state: BackendState;
    restarts: number;
    since: number | null;
  } | null;
  computer: "none" | "offline" | "online";
  /** Who may open it at its own address. */
  access: "owner" | "circles" | "public";
  /** That address, or null where this Pim has none for apps. */
  address: string | null;
};

/** An app, as its latest version. */
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

/** An app someone shared with you: its latest version, from their Pim. */
export type SharedArtifact = Omit<Artifact, "session"> & {
  /** Whose it is: their username. */
  host: string;
  /** Where an app with a backend is opened, which isn't here; null for any other, or where there's no address for it. */
  address?: string | null;
};

/** An app someone published for everyone on this Pim: a copy of one of its versions. */
export type PublishedArtifact = {
  id: string;
  author: string;
  authorName: string | null;
  /** Which of the author's apps it copies, and which version. */
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

/** What you published of one of your apps, with its public link if it has one, and whether it can. */
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
  /** Where it was installed from: a GitHub folder at a commit, or a folder in your files; null for one an agent wrote. */
  source: string | null;
  createdAt: number;
};

export type SkillVersion = SkillVersionInfo & {
  name: string;
  description: string;
  instructions: string;
  /** Supporting files, by their paths relative to the skill, their sizes in bytes and their media types. */
  files: { path: string; size: number; type: string }[];
};

/** Where the browser reads a skill's supporting file at a version, or downloads it. */
export const skillFileUrl = (
  name: string,
  version: number,
  path: string,
  download = false,
) =>
  `/api/skills/${encodeURIComponent(name)}/versions/${version}/file?path=${encodeURIComponent(path)}${download ? "&download" : ""}`;

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

/** What an app tool answers: a reference to the version it made, never its content. */
export type ArtifactReference = {
  id: string;
  title: string;
  kind: ArtifactKind;
  version: number;
  sha256: string;
  size: number;
};

/** Whose an app is, when it isn't yours: one `host` (their username) shares with you, or one published to everyone. */
export type ArtifactFrom = { host: string } | { published: true };

/** Where an app is in the API. */
const artifactRoot = (id: string, from?: ArtifactFrom) =>
  !from
    ? `/artifacts/${encodeURIComponent(id)}`
    : "host" in from
      ? `/shared-artifacts/${encodeURIComponent(from.host)}/${encodeURIComponent(id)}`
      : `/published-artifacts/${encodeURIComponent(id)}`;

const artifactPath = (id: string, version: number, from?: ArtifactFrom) =>
  `/api${artifactRoot(id, from)}/versions/${version}`;

/** The sandboxed page a framed app's version is shown in. */
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

/**
 * Your computer, which your agents run commands on and keep your files on:
 * none connected, paired but not connected now, or connected.
 */
export type ComputerStatus = {
  state: "none" | "offline" | "online";
  /** Whether it's the one this Pim's computer host keeps for you: permanent, and set up for you. */
  managed: boolean;
  pairedAt: number | null;
  /** Why the computer host couldn't set it up, until it connects. */
  error: string | null;
  /** What it said about itself when it last connected. */
  computer: {
    agent: string;
    hostname: string;
    platform: string;
    arch: string;
    user: string;
    /** The folder on it that holds your files. */
    root: string;
    /** The Chrome your agents browse with there, or null where it has none. */
    browser: string | null;
    /** Whether it streams its desktop, for you to use in the Computer dialog. */
    screen: boolean;
    /** Whether agents can use its desktop's apps. */
    desktop: boolean;
    connectedAt: number;
  } | null;
};

/** The machine that keeps everyone's computers, as the admin sees it. */
export type ComputerHostStatus = {
  paired: boolean;
  pairedAt: number | null;
  /** When it last asked for work, and whether that's recent enough to call it connected. */
  seenAt: number | null;
  connected: boolean;
  image: string | null;
  /** Whether it makes computers as `vm`s or `container`s. */
  kind: string | null;
  version: string | null;
  machines: number;
  running: number;
  pending: number;
};

/** The browser your agents share: whether this Pim has one, and the page a chat's window shows when it's open. */
export type BrowserStatus = {
  available: boolean;
  /** The page it shows. */
  page: { url: string; title: string } | null;
};

/** A picture of the page a chat's window shows, as fetched at `at`. */
export const browserScreenshotUrl = (sessionId: string, at: number) =>
  `/api/browser/screenshot?session=${encodeURIComponent(sessionId)}&at=${at}`;

/** Where the app takes the browser over: a socket that hears the page and sends what the person does. */
export const BROWSER_LIVE_PATH = "/api/browser/live";

/** What the browser's socket says: the page as a picture, which page it is, or what went wrong. */
export type BrowserLiveMessage =
  | { type: "frame"; data: string; width: number; height: number }
  | { type: "page"; url: string; title: string }
  | { type: "error"; message: string };

/** What the person does in the browser, in DevTools' terms (src/browser.ts's `BrowserInput`). */
export type BrowserInput =
  | {
      type: "mouse";
      event: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
      x: number;
      y: number;
      button?: "none" | "left" | "middle" | "right";
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: number;
    }
  | {
      type: "key";
      event: "keyDown" | "keyUp";
      key: string;
      code: string;
      text?: string;
      keyCode?: number;
      modifiers?: number;
    }
  | { type: "text"; text: string }
  | { type: "navigate"; url: string }
  | { type: "back" | "forward" | "reload" };

export type DayUsage = {
  day: string;
  tokens: number;
  planTokens: number;
  modelRequests: number;
  runs: number;
  toolCalls: number;
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
  /** A guest joined through a bot's public link, and only chats with that bot. */
  role: "admin" | "member" | "guest";
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
  role: "admin" | "member" | "guest";
  status: "pending" | "active" | "suspended" | "deleting" | "deleted";
  createdAt: number;
  activatedAt: number | null;
  statusReason: string | null;
};

/** What a bot's public link shows before anyone joins through it. */
export type BotCard = {
  id: string;
  author: string;
  authorName: string | null;
  name: string;
  description: string;
  symbol: string | null;
  color: string | null;
  /** When its uploaded icon was shared; null without one. */
  icon: number | null;
};

/** A guest's bot: what its link shows and the messages and tool calls a day it allows (null when it's turned off), and their copy of it. */
export type GuestBot = {
  bot:
    | (BotCard & {
        dailyMessages: number | null;
        dailyToolCalls: number | null;
      })
    | null;
  agent: string | null;
};

/** A tool of an agent's that a bot can share with its guests. */
export type ShareableTool = {
  name: string;
  /** Its connector; null for Pim's own, such as generate_image. */
  appName: string | null;
  description: string;
  /** The connector says it changes or deletes things. */
  destructive: boolean;
};

/** One of the admin's agents shared as a bot: its public link, and who joined through it. */
export type BotSharing = {
  id: string;
  url: string;
  dailyMessages: number | null;
  /** Tool calls each guest may make a day; null for this Pim's own limit. */
  dailyToolCalls: number | null;
  /** The model guests use; null for this Pim's default. */
  model: { provider: string; id: string } | null;
  /** The tools it shares, by name, which run in your space, as you. */
  tools: string[];
  /** Those of them you approve each call to first. */
  ask: string[];
  sharedAt: number;
  guests: number;
};

/** Whether Pim may use a tool: not at all, after asking you, or without asking. */
export type ToolPermission = "off" | "ask" | "on";

/** A tool you can set a permission for, and the permission that applies. */
export type ToolPermissionInfo = {
  /** The connector's id; null for Pim's own tools. */
  app: string | null;
  appName: string | null;
  /** The tool's own name, which its permission is set by. */
  tool: string;
  /** The name the model sees. */
  name: string;
  description: string | null;
  /** The connector says the tool only reads. */
  readOnly: boolean;
  /** The connector says the tool may delete or overwrite things. */
  destructive: boolean;
  permission: ToolPermission;
  /** What applies when you haven't chosen. */
  default: ToolPermission;
  chosen: ToolPermission | null;
  /** The connector changed the tool since you chose to let it run: Pim asks again, and circles lose it. */
  changed: boolean;
  /** The permissions it can have. */
  choices: ToolPermission[];
};

export type PimNotification = {
  id: string;
  /** `mention` when an agent tagged you in a chat. */
  kind: "general" | "mention" | "scheduled";
  session: string | null;
  agent: Pick<Agent, "id" | "icon" | "symbol" | "color"> | null;
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
  /** The agent each new chat is with, when the majordomo scheduled it for another agent. */
  agent?: string;
};

/*
 * Triggers, as the API in docs/triggers.md ("The API") gives them. The
 * routes exist only where a space's triggers are on; elsewhere they answer
 * 404 as any unknown path does.
 */

export const TRIGGER_LIFECYCLES = [
  "draft",
  "enabled",
  "paused",
  "ended",
  "deleted",
] as const;
export type TriggerLifecycle = (typeof TRIGGER_LIFECYCLES)[number];

export const TRIGGER_HEALTHS = [
  "unknown",
  "healthy",
  "waiting_computer",
  "reconnecting",
  "gap",
  "auth_required",
  "budget_blocked",
  "configuration_error",
] as const;
export type TriggerHealth = (typeof TRIGGER_HEALTHS)[number];

export const TRIGGER_SOURCE_KINDS = [
  "time",
  "connector_event",
  "poll",
  "stream",
  "process",
  "file",
] as const;
export type TriggerSourceKind = (typeof TRIGGER_SOURCE_KINDS)[number];

/** What a trigger watches. Times are milliseconds since 1970. */
export type TriggerSource =
  | { kind: "time"; schedule: "once"; at: number; maxLatenessMs: number }
  | {
      kind: "time";
      schedule: "cron";
      expression: string;
      timeZone: string;
      catchUpMs: number;
    }
  | {
      kind: "time";
      schedule: "interval";
      everyMs: number;
      anchorAt: number;
      catchUpMs: number;
    }
  | {
      kind: "connector_event";
      connectorId: string;
      event: string;
      arguments: Record<string, unknown>;
    }
  | {
      kind: "poll";
      command: string;
      cwd: string | null;
      intervalMs: number;
      deadlineMs: number;
    }
  | { kind: "stream"; command: string; cwd: string | null }
  | { kind: "process"; handle: string; expiresAt: number }
  | {
      kind: "file";
      path: string;
      events: ("created" | "modified" | "deleted")[];
      recursive: boolean;
    };

/** A condition's expression: JSON, never code (docs/triggers.md, "Conditions"). */
export type TriggerExpression =
  | {
      op: "compare";
      path: string[];
      cmp: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
      value: string | number | boolean;
    }
  | { op: "exists"; path: string[] }
  | { op: "changed"; path: string[] }
  | { op: "all" | "any"; of: TriggerExpression[] }
  | { op: "not"; of: TriggerExpression }
  | { op: "stable_for"; ms: number; of: TriggerExpression }
  | {
      op: "hysteresis";
      path: string[];
      direction: "rising" | "falling";
      enter: number;
      exit: number;
    };

export type TriggerCondition = {
  when: TriggerExpression;
  staleAfterMs?: number | null;
};

export type TriggerDestination =
  | { type: "new_chat" }
  | { type: "existing_chat"; chatId: string };

export type TriggerSourceStatus = "available" | "draft_only" | "unavailable";

export type TriggerGrantState =
  | "not_required"
  | "missing"
  | "pending_approval"
  | "current"
  | "not_current";

export type Trigger = {
  id: string;
  /** The spec's revision: lifecycle and health change without it. */
  revision: number;
  /** What the person wants. */
  lifecycle: TriggerLifecycle;
  /** How the source is doing, apart from the lifecycle. */
  health: TriggerHealth;
  /** Why health is `unknown` when evidence was lost; absent while nothing has been checked yet. */
  healthDetail?: string | null;
  agentId: string;
  label: string;
  instruction: string;
  source: TriggerSource;
  condition: TriggerCondition | null;
  destination: TriggerDestination;
  origin: { type: "api" } | { type: "chat"; chatId: string };
  policies: {
    lateness:
      | { maxLatenessMs: number; missed: "recorded" }
      | { catchUpMs: number; coalesce: "latest_due" }
      | null;
    maxPendingEvents: number | null;
    pendingSnapshots: number | null;
    rawSamples: false;
    runsAtOnce: number;
    deliveryTtlMs: number;
    replayHorizonMs: number | null;
    staleAfterMs: number | null;
  };
  /** For time sources: the next firing after now, and when the engine looks next (only while enabled). */
  schedule: { nextFiringAt: number | null; nextCheckAt: number | null } | null;
  capability: {
    status: TriggerSourceStatus;
    delivers: boolean;
    reason: string | null;
  };
  grant: { required: boolean; state: TriggerGrantState };
  /** A shadow of a schedule or connector watch: owned by it, or, once cut over, owning its work. It changes only through the migration while its phase is `shadow`. */
  migration: {
    kind: "schedule" | "watch";
    legacyId: string;
    owner: "legacy" | "trigger";
    phase: string;
    enableable: boolean;
    /** When the owner last changed; null while it never did. */
    ownerSince: number | null;
  } | null;
  createdAt: number;
  updatedAt: number;
};

export const TRIGGER_RUN_STATES = [
  "pending",
  "preparing",
  "submitting",
  "accepted",
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
  "not_submitted",
  "missed",
  "superseded",
  "outcome_unknown",
] as const;
export type TriggerRunState = (typeof TRIGGER_RUN_STATES)[number];

/** One occurrence of a trigger and what came of it, as far as Pim knows. */
export type TriggerRun = {
  id: string;
  triggerId: string;
  revision: number;
  state: TriggerRunState;
  /** Whether `state` is final and known. */
  outcomeKnown: boolean;
  occurrenceStatus: string;
  phase: string | null;
  dueAt: number;
  /** Why it fired: times, and for events only which fields were there. */
  evidence:
    | { reason: "time"; scheduledFor: number; older?: unknown }
    | {
        reason: string;
        truth: string;
        observedAt: number;
        fields: { path: string[]; present: boolean }[];
      };
  /** The chat it was pinned to, once pinned. */
  chatId: string | null;
  deliverBy: number | null;
  submittedAt: number | null;
  acceptedAt: number | null;
  endedAt: number | null;
  deferrals: number;
  unknownAnswers: number;
  createdAt: number;
  updatedAt: number;
};

/** A dry run: what a trigger would do, computed without writing or running anything. */
export type TriggerDryRun = {
  dryRun: true;
  valid: true;
  sourceKind: TriggerSourceKind;
  capability: Trigger["capability"];
  grant: Trigger["grant"];
  policies: Trigger["policies"];
  blockers: string[];
  id?: string;
  revision?: number;
  lifecycle?: TriggerLifecycle;
  firings?: { at: number; timeZone: string; local: string; offset: string }[];
  skippedCount?: number;
  exhausted?: boolean;
  evaluations?: {
    index: number;
    truth: "true" | "false" | "unknown";
    fires: boolean;
    stale: boolean;
  }[];
};

/** What making a trigger takes; `enabled` is left false, so it is a draft. */
export type TriggerInput = {
  label: string;
  instruction: string;
  source: TriggerSource;
  condition?: TriggerCondition | null;
  destination: TriggerDestination;
  agentId?: string;
};

export type TriggerFilters = {
  lifecycle?: TriggerLifecycle;
  agentId?: string;
  sourceKind?: TriggerSourceKind;
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
  /** The model of agents that have none of their own. */
  model: ModelInfo;
  /** The deployment's own model, used when nothing else is chosen. */
  default: ModelInfo;
  choices: ModelInfo[];
  /** Whether this Pim has Workers AI; without it, models come only from providers. */
  workersAi: boolean;
  /** The utility model, for side jobs: naming chats, improving prompts, summarizing. Null when there is none. */
  utility: {
    model: ModelInfo | null;
    default: ModelInfo | null;
    choices: ModelInfo[];
  };
  chatgpt: ChatGPTStatus & { error: string | null };
  /** Whether the plan is connected for images, which is a sign-in of its own. */
  chatgptImages: ChatGPTStatus;
  /** Providers besides Workers AI and the ChatGPT plan: the admin's for everyone, then the person's own. */
  providers: ModelProvider[];
};

/** A model's price in dollars per million tokens. */
export type ModelCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** What the person set for a custom endpoint's model: its real context window and its price. */
export type ModelOverride = { contextWindow?: number; cost?: ModelCost };

/** A model on a provider someone added, with what Pim knows about it. */
export type ProviderModelInfo = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  images: boolean;
  reasoning: boolean;
  cost?: ModelCost;
};

/** A built-in service or custom endpoint the person or admin added. Never its key. */
export type ModelProvider = {
  id: string;
  builtin?: string;
  /** Its models' `provider`: `own:<id>` or `shared:<id>`. */
  provider: string;
  name: string;
  url: string;
  hasKey: boolean;
  /** The models named when it was added; null offers every model the server lists. */
  chosen: string[] | null;
  models: ProviderModelInfo[];
  /** The admin's, for everyone on this Pim. */
  shared: boolean;
  /** A custom endpoint's models answer in a JSON schema, which lets them be the utility model. */
  structuredOutput?: boolean;
  /** A custom endpoint's API when it isn't OpenAI's chat completions. */
  api?: "anthropic-messages";
  /** A custom endpoint's models' settings by model id. */
  overrides?: Record<string, ModelOverride>;
};

/** A provider as adding or changing it answers. */
export type SavedProvider = Omit<ModelProvider, "provider" | "shared">;

/** Adding or changing a provider; a field left out stays as it was, and an empty key takes it away. */
export type ProviderInput = {
  builtin?: string;
  name?: string;
  url?: string;
  key?: string;
  models?: string[] | null;
  structuredOutput?: boolean;
  api?: "openai-completions" | "anthropic-messages";
  /** Every model's settings by model id; one left out goes back to what the server says. */
  overrides?: Record<string, ModelOverride>;
};

export type BuiltinProvider = {
  id: string;
  name: string;
  models: ProviderModelInfo[];
};

/** OpenAI's provider id: models that run on the ChatGPT plan. */
export const CHATGPT_PROVIDER = "openai";

/** What Pim sends on a session's WebSocket. */
export type ServerMessage =
  | { type: "hello"; session: string; tools: unknown[] }
  | { type: "events"; session: string; events: AgentEvent[] }
  | { type: "progress"; session: string; text: string; calls: string[] }
  | { type: "notification"; notification: PimNotification }
  | { type: "approval"; approval: Approval }
  | { type: "visits" }
  | { type: "sessions" }
  | { type: "tasks"; session: string }
  | { type: "computer" }
  | { type: "result"; id: string; result: unknown }
  | { type: "error"; id?: string; message: string };

/** An API answer that isn't a success, with its status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The refusal as Pim sent it, such as a trigger's `{ error, code, field }`. */
    readonly body: Record<string, unknown> | null = null,
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
      body as Record<string, unknown> | null,
    );
  }
  return body as T;
}

export const pim = {
  memory: () =>
    call<{
      count: number;
      pendingCompressions: number;
      view: string[];
      scopes: MemoryScopeInfo[];
    }>("/memory"),
  memoryLog: (scope = "", before?: number) =>
    call<{ entries: MemoryEntry[] }>(
      `/memory/log?limit=30${scope ? `&scope=${encodeURIComponent(scope)}` : ""}${before === undefined ? "" : `&before=${before}`}`,
    ),
  addMemory: (text: string, scope = "private") =>
    call<MemoryEntry>("/memory/log", {
      method: "POST",
      body: JSON.stringify({ text, scope }),
    }),
  moveMemory: (id: number, scope: string) =>
    call<MemoryEntry>(`/memory/log/${id}`, {
      method: "PUT",
      body: JSON.stringify({ scope }),
    }),
  forgetMemory: (id: number) =>
    call<unknown>(`/memory/log/${id}`, { method: "DELETE" }),
  createMemoryScope: (name: string) =>
    call<MemoryScopeInfo>("/memory/scopes", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  renameMemoryScope: (key: string, name: string) =>
    call<MemoryScopeInfo>(`/memory/scopes/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    }),
  deleteMemoryScope: (key: string) =>
    call<unknown>(`/memory/scopes/${encodeURIComponent(key)}`, {
      method: "DELETE",
    }),
  sessions: () =>
    call<{ sessions: Session[] }>("/sessions").then((body) => body.sessions),
  createSession: (options: { title?: string; agent?: string } = {}) =>
    call<Session>("/sessions", {
      method: "POST",
      body: JSON.stringify(options),
    }),
  /** A new chat with what was said in this one: through an agent's message (`at`), or up to one of yours (`before`). */
  forkSession: (id: string, from: { at: string } | { before: string }) =>
    call<Session>(`/sessions/${id}/fork`, {
      method: "POST",
      body: JSON.stringify(from),
    }),
  readSession: (id: string, responseAt: number) =>
    call<Session>(`/sessions/${id}/read`, {
      method: "POST",
      body: JSON.stringify({ responseAt }),
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
  computer: () => call<ComputerStatus>("/computer"),
  /** Pairs a computer in place of any other; its token is shown only now. */
  pairComputer: () =>
    call<ComputerStatus & { token: string }>("/computer", { method: "POST" }),
  /** Asks the computer host to set up the computer it keeps for you again, after it couldn't. */
  setUpComputer: () =>
    call<ComputerStatus>("/computer", {
      method: "POST",
      body: JSON.stringify({ managed: true }),
    }),
  removeComputer: () => call<ComputerStatus>("/computer", { method: "DELETE" }),
  browser: (sessionId: string) =>
    call<BrowserStatus>(`/browser?session=${encodeURIComponent(sessionId)}`),
  closeBrowser: (sessionId: string) =>
    call<{ closed: boolean }>(
      `/browser?session=${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    ),
  removeAgentIcon: (id: string) =>
    call<Agent>(`/agents/${id}/icon`, { method: "DELETE" }),
  deleteAgent: (id: string) =>
    call<{ deleted: boolean }>(`/agents/${id}`, { method: "DELETE" }),
  extensions: () => call<Extensions>("/extensions"),
  /** Your majordomo, and whether it has opened your first chat yet. */
  majordomo: () => call<MajordomoState>("/majordomo"),
  /** Changes how your majordomo talks and how much it handles on its own. */
  setMajordomoPreferences: (preferences: MajordomoPreferences) =>
    call<MajordomoState>("/majordomo/preferences", {
      method: "PUT",
      body: JSON.stringify(preferences),
    }),
  /** Has your majordomo open your first chat, once, where you set it up by talking with it; returns its id. */
  setUpMajordomo: (setup: MajordomoStart) =>
    call<MajordomoState & { session: string }>("/majordomo", {
      method: "POST",
      body: JSON.stringify(setup),
    }),
  /**
   * Messages to say next in a chat, written by the utility model from that chat
   * once something has been said in it. They can take a few seconds.
   */
  suggestions: (session: string, locale: string) =>
    call<{ suggestions: string[] }>(
      `/sessions/${session}/suggestions?locale=${encodeURIComponent(locale)}`,
    ).then((answer) => answer.suggestions),
  publishAgent: (id: string) =>
    call<Template>(`/agents/${id}/publish`, { method: "POST" }),
  unpublishAgent: (id: string) =>
    call<{ deleted: boolean }>(`/agents/${id}/publish`, { method: "DELETE" }),
  /** The admin's agent's public bot link; null when it has none. */
  agentBot: (id: string) =>
    call<BotSharing>(`/agents/${id}/bot`).catch((error) => {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }),
  /** Shares the agent as it is now as a bot, or updates what its link shares. */
  shareBot: (
    id: string,
    settings: Pick<
      BotSharing,
      "dailyMessages" | "dailyToolCalls" | "model" | "tools" | "ask"
    >,
  ) =>
    call<BotSharing>(`/agents/${id}/bot`, {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  /** What of the agent's you can share with a bot's guests: its connected apps' tools, and generate_image while you make images. */
  agentBotTools: (id: string) =>
    call<{ tools: ShareableTool[] }>(`/agents/${id}/bot-tools`).then(
      (body) => body.tools,
    ),
  unshareBot: (id: string) =>
    call<{ deleted: boolean }>(`/agents/${id}/bot`, { method: "DELETE" }),
  /** A guest's bot. */
  guestBot: () => call<GuestBot>("/bot"),
  /** What a bot's public link shows; anyone can read it, signed in or not. */
  publicBot: (id: string) => call<BotCard>(`/bots/${encodeURIComponent(id)}`),
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
  /** The apps Pim brings that the admin left on. */
  builtinApps: () =>
    call<{ apps: BuiltinApp[] }>("/builtin-apps").then((body) => body.apps),
  /** The connectors you can connect. */
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
  unarchiveSession: (id: string) =>
    call<Session>(`/sessions/${id}/unarchive`, { method: "POST" }),
  archiveSession: (id: string) =>
    call<Session>(`/sessions/${id}/archive`, { method: "POST" }),
  deleteSession: (id: string) =>
    call<{ deleted: boolean }>(`/sessions/${id}`, { method: "DELETE" }),
  /** What the model requests in a chat have cost, by model. */
  sessionCost: (id: string) => call<SessionCost>(`/sessions/${id}/cost`),
  chatLink: (id: string) =>
    call<{ link: ChatLink | null }>(`/sessions/${id}/link`).then(
      (body) => body.link,
    ),
  /** Makes the chat's public link show the chat as it is now: a new link, or the one it has. */
  shareChat: (id: string) =>
    call<{ link: ChatLink }>(`/sessions/${id}/link`, { method: "PUT" }).then(
      (body) => body.link,
    ),
  unshareChat: (id: string) =>
    call<{ deleted: boolean }>(`/sessions/${id}/link`, { method: "DELETE" }),
  /** What a chat's public link shows; anyone can read it, signed in or not. */
  sharedChat: (owner: string, link: string) =>
    call<SharedChat>(
      `/shared/${encodeURIComponent(owner)}/${encodeURIComponent(link)}`,
    ),
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
  addToRoom: (session: string, agent: string) =>
    call<{ room: Room | null }>(`/sessions/${session}/room/members`, {
      method: "POST",
      body: JSON.stringify({ agent }),
    }).then((body) => body.room),
  removeFromRoom: (session: string, agent: string) =>
    call<{ room: Room | null }>(`/sessions/${session}/room/members/${agent}`, {
      method: "DELETE",
    }).then((body) => body.room),
  /** Asks a group chat's agent again, whose run is held after a model error. */
  retryInRoom: (session: string, agent: string) =>
    call<{ room: Room | null }>(
      `/sessions/${session}/room/members/${agent}/retry`,
      { method: "POST" },
    ).then((body) => body.room),
  /** Has a message queued behind the work join it after the agent's current step. */
  steerQueued: (session: string, id: number) =>
    call<{ id: number }>(`/sessions/${session}/queue/${id}/steer`, {
      method: "POST",
    }),
  /** Rewrites a queued message's text, keeping its images. */
  editQueued: (session: string, id: number, text: string) =>
    call<{ id: number }>(`/sessions/${session}/queue/${id}`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    }),
  /** Takes a queued message back before the agent reads it. */
  cancelQueued: (session: string, id: number) =>
    call<{ id: number }>(`/sessions/${session}/queue/${id}`, {
      method: "DELETE",
    }),
  abort: (session: string) =>
    call<{ aborted: boolean }>(`/sessions/${session}/abort`, {
      method: "POST",
    }),
  /** Asks the model again in a chat held after a model error. */
  retry: (session: string) =>
    call<{ session: string }>(`/sessions/${session}/retry`, {
      method: "POST",
    }),
  approvals: (status?: ApprovalStatus) =>
    call<{ approvals: Approval[] }>(
      `/approvals${status ? `?status=${status}` : ""}`,
    ).then((body) => body.approvals),
  approval: (id: string) =>
    call<Approval>(`/approvals/${encodeURIComponent(id)}`),
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
  /** Whether an agent may use each tool of the connectors it works with: on or off. */
  agentPermissions: (agent: string) =>
    call<{ tools: ToolPermissionInfo[] }>(
      `/permissions?agent=${encodeURIComponent(agent)}`,
    ).then((body) => body.tools),
  /** An agent's switch for skills: on, it writes and installs skills with your approval, and your majordomo may for it. */
  agentSkillsPermission: (agent: string) =>
    call<{ skills: ToolPermissionInfo }>(
      `/permissions?agent=${encodeURIComponent(agent)}`,
    ).then((body) => body.skills),
  setAgentPermission: (
    agent: string,
    app: string,
    tool: string,
    permission: "on" | "off" | null,
  ) =>
    call<ToolPermissionInfo>("/permissions", {
      method: "PUT",
      body: JSON.stringify({ agent, app, tool, permission }),
    }),
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
  updateCircle: (
    id: string,
    change: { name?: string; enabled?: boolean; memoryScopes?: string[] },
  ) =>
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
  /** A page of triggers, oldest first; 404 where the space's triggers are off. */
  triggers: (filters: TriggerFilters = {}, cursor?: string, limit = 20) => {
    const query = new URLSearchParams({ limit: String(limit) });
    for (const [name, value] of Object.entries(filters)) {
      if (value) query.set(name, value);
    }
    if (cursor) query.set("cursor", cursor);
    return call<{ triggers: Trigger[]; nextCursor: string | null }>(
      `/triggers?${query}`,
    );
  },
  trigger: (id: string) => call<Trigger>(`/triggers/${encodeURIComponent(id)}`),
  /** Makes a draft; the key makes a retried request give the same trigger. */
  createTrigger: (input: TriggerInput, idempotencyKey: string) =>
    call<Trigger>("/triggers", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    }),
  /** Changes a trigger only if it is still at the revision the person reviewed. */
  updateTrigger: (
    id: string,
    revision: number,
    change: Partial<Omit<TriggerInput, "agentId">>,
  ) =>
    call<Trigger>(`/triggers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "if-match": `"${revision}"` },
      body: JSON.stringify(change),
    }),
  pauseTrigger: (id: string, revision: number) =>
    call<Trigger>(`/triggers/${encodeURIComponent(id)}/pause`, {
      method: "POST",
      headers: { "if-match": `"${revision}"` },
    }),
  resumeTrigger: (id: string, revision: number) =>
    call<Trigger>(`/triggers/${encodeURIComponent(id)}/resume`, {
      method: "POST",
      headers: { "if-match": `"${revision}"` },
    }),
  deleteTrigger: (id: string, revision: number) =>
    call<{ deleted: true; trigger: Trigger }>(
      `/triggers/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: { "if-match": `"${revision}"` } },
    ),
  /** A dry run: writes nothing, starts no agent and runs no command. */
  testTrigger: (id: string) =>
    call<TriggerDryRun>(`/triggers/${encodeURIComponent(id)}/test`, {
      method: "POST",
      body: JSON.stringify({ count: 5 }),
    }),
  triggerRuns: (id: string, cursor?: string, limit = 20) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return call<{ runs: TriggerRun[]; nextCursor: string | null }>(
      `/triggers/${encodeURIComponent(id)}/runs?${query}`,
    );
  },
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
  model: () => call<ModelSettings>("/model"),
  chooseModel: (model: Pick<ModelInfo, "provider" | "id">) =>
    call<{ model: ModelInfo }>("/model", {
      method: "PUT",
      body: JSON.stringify(model),
    }),
  /** Null follows the default model again. */
  chooseAgentModel: (
    agent: string,
    model: Pick<ModelInfo, "provider" | "id"> | null,
  ) =>
    call<Agent>(`/agents/${encodeURIComponent(agent)}/model`, {
      method: "PUT",
      body: JSON.stringify(model ?? { provider: null, id: null }),
    }),
  setAgentFallbacks: (
    agent: string,
    models: Pick<ModelInfo, "provider" | "id">[],
  ) =>
    call<Agent>(`/agents/${encodeURIComponent(agent)}/fallbacks`, {
      method: "PUT",
      body: JSON.stringify({ models }),
    }),
  chooseUtilityModel: (model: Pick<ModelInfo, "provider" | "id">) =>
    call<{ model: ModelInfo | null }>("/model/utility", {
      method: "PUT",
      body: JSON.stringify(model),
    }),
  builtinProviders: () =>
    call<{ providers: BuiltinProvider[] }>("/providers/built-in"),
  addProvider: (input: ProviderInput) =>
    call<{ provider: SavedProvider }>("/providers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateProvider: (id: string, input: ProviderInput) =>
    call<{ provider: SavedProvider }>(`/providers/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  removeProvider: (id: string) =>
    call<{ deleted: boolean }>(`/providers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  chatgptLogin: () =>
    call<{ url: string }>("/chatgpt/login", { method: "POST" }),
  chatgptCallback: (url: string) =>
    call<ChatGPTStatus>("/chatgpt/callback", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  chatgptLogout: () => call<ChatGPTStatus>("/chatgpt", { method: "DELETE" }),
  chatgptImagesLogin: () =>
    call<{ url: string }>("/chatgpt/images/login", { method: "POST" }),
  chatgptImagesCallback: (url: string) =>
    call<ChatGPTStatus>("/chatgpt/images/callback", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  chatgptImagesLogout: () =>
    call<ChatGPTStatus>("/chatgpt/images", { method: "DELETE" }),
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
  /** What you published of one of your apps; null when you haven't. */
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
  /** Makes a published app one of yours. */
  adoptArtifact: (id: string) =>
    call<Artifact>(`${artifactRoot(id, { published: true })}/use`, {
      method: "POST",
    }),

  setArtifactCircles: (id: string, circles: string[]) =>
    call<ArtifactDetail>(`/artifacts/${encodeURIComponent(id)}/circles`, {
      method: "PUT",
      body: JSON.stringify({ circles }),
    }),
  artifactBackend: (id: string) =>
    call<ArtifactBackend>(`/artifacts/${encodeURIComponent(id)}/backend`),
  artifactBackendLogs: (id: string) =>
    call<{ text: string }>(
      `/artifacts/${encodeURIComponent(id)}/backend/logs`,
    ).then((body) => body.text),
  stopArtifactBackend: (id: string) =>
    call<{ stopped: boolean }>(
      `/artifacts/${encodeURIComponent(id)}/backend/stop`,
      { method: "POST", body: "{}" },
    ),
  /** Runs a version's backend on the computer, in place of the one running; it waits for the backend to come up. */
  runArtifactBackend: (id: string, version: number) =>
    call<{ running: number }>(
      `/artifacts/${encodeURIComponent(id)}/backend/run`,
      { method: "POST", body: JSON.stringify({ version }) },
    ),
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
  /** One call an app made through its bridge: its answer, or what the person must allow first. */
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
  renameArtifact: (id: string, title: string) =>
    call<Artifact>(`/artifacts/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ title }),
    }),
  /** Starts an empty note, to write in with your agents. */
  createNote: (title: string) =>
    call<Artifact>("/notes", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
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

/** One of the apps Pim brings, such as Notes. */
export type BuiltinApp = { id: string; name: string; description: string };

export const admin = {
  /** Pim's built-in apps, and which the admin left on for everyone. */
  builtinApps: () =>
    call<{ apps: (BuiltinApp & { enabled: boolean })[] }>(
      "/admin/builtin-apps",
    ).then((body) => body.apps),
  /** Turns one of Pim's built-in apps on or off for everyone. */
  setBuiltinApp: (id: string, enabled: boolean) =>
    call<{ apps: (BuiltinApp & { enabled: boolean })[] }>(
      `/admin/builtin-apps/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify({ enabled }) },
    ).then((body) => body.apps),
  /** Takes a published app down, for everyone. */
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
  /** The machine that keeps everyone's computers. */
  computerHost: () => call<ComputerHostStatus>("/admin/computer-host"),
  /** Pairs a computer host in place of any other; its token is shown only now. */
  pairComputerHost: () =>
    call<ComputerHostStatus & { token: string }>("/admin/computer-host", {
      method: "POST",
    }),
  forgetComputerHost: () =>
    call<ComputerHostStatus>("/admin/computer-host", { method: "DELETE" }),
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
  /** Adds a connector everyone on this Pim can connect: a remote MCP server. */
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
  /** Gives a connector the admin added another icon, by its id; an empty one looks its site's up again. */
  setAppIcon: (id: string, icon: string) =>
    call<{ app: { id: string } }>(`/admin/apps/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ icon }),
    }),
  /** Takes a connector the admin added out of the directory, by its id (`custom/<id>`). */
  removeApp: (id: string) =>
    call<{ deleted: boolean }>(`/admin/apps/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: "{}",
    }),
  /** Model providers everyone on this Pim can use. */
  addProvider: (input: ProviderInput) =>
    call<{ provider: SavedProvider }>("/admin/providers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateProvider: (id: string, input: ProviderInput) =>
    call<{ provider: SavedProvider }>(
      `/admin/providers/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify(input) },
    ),
  removeProvider: (id: string) =>
    call<{ deleted: boolean }>(`/admin/providers/${encodeURIComponent(id)}`, {
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
