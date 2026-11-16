import { Agents } from "./agents.ts";
import { Apps } from "./apps.ts";
import { Canvas } from "./canvas.ts";
import { Conversations } from "./conversations.ts";
import { type Connectors as ConnectorsType, Connectors, type CodeExchanger, type ToolFetcher } from "./connectors.ts";
import { KeyringCrypto } from "./crypto.ts";
import { type Db } from "./db.ts";
import { Identity } from "./identity.ts";
import { McpOAuth } from "./mcp.ts";
import { Memories } from "./memory.ts";
import { Providers } from "./providers.ts";
import { Sharing, type TranscriptSource } from "./sharing.ts";
import { Triggers } from "./triggers.ts";
import { Usage } from "./usage.ts";
import { ExternalSignIn, type ProviderId, type ProviderSettings } from "./oauth.ts";
import { Approvals, Operations } from "./operations.ts";
import type { EnvelopeCrypto, ObjectStore } from "@pim/v2-contracts/platform";
import { randomBytes } from "node:crypto";
import { Objects } from "./objects.ts";
import { Relay } from "./relay.ts";
import { Schedules } from "./schedules.ts";
import { SignIn } from "./signin.ts";

/** The application's services, built once over one database and one object store. Optional parts (a computer, a coding pool) are simply absent. */
export class App {
	readonly identity: Identity;
	readonly conversations: Conversations;
	readonly memories: Memories;
	readonly schedules: Schedules;
	readonly operations: Operations;
	readonly approvals: Approvals;
	readonly objects: Objects;
	readonly canvas: Canvas;
	readonly relay: Relay;
	readonly signin: SignIn;
	readonly external: ExternalSignIn;
	readonly mcp: McpOAuth;
	readonly agents: Agents;
	readonly providers: Providers;
	readonly connectors: ConnectorsType;
	readonly usage: Usage;
	readonly triggers: Triggers;
	readonly apps: Apps;
	readonly sharing: Sharing;
	readonly crypto: EnvelopeCrypto;
	constructor(readonly db: Db, store: ObjectStore, opts: { hideSuspended?: boolean; providers?: Partial<Record<ProviderId, ProviderSettings>>; crypto?: EnvelopeCrypto; appKey?: string; fetchTools?: ToolFetcher; exchange?: CodeExchanger; transcripts?: TranscriptSource } = {}) {
		this.identity = new Identity(db);
		this.conversations = new Conversations(db);
		this.memories = new Memories(db);
		this.schedules = new Schedules(db, this.conversations);
		this.operations = new Operations(db);
		this.approvals = new Approvals(db);
		this.objects = new Objects(db, store, opts);
		this.canvas = new Canvas(db, store);
		this.relay = new Relay(db, this.identity, undefined, opts.appKey);
		this.signin = new SignIn(db, this.identity);
		this.external = new ExternalSignIn(db, this.signin, this.identity, opts.providers ?? {});
		this.mcp = new McpOAuth(db, this.identity, this.signin, this.conversations);
		// Without a configured keyring (PIM_KEYS) a process gets a key of its own, so values it seals do not survive a restart: fine for a trial, never for a deployment.
		this.crypto = opts.crypto ?? new KeyringCrypto("ephemeral", { ephemeral: new Uint8Array(randomBytes(32)) });
		this.agents = new Agents(db);
		this.providers = new Providers(db, this.crypto);
		this.usage = new Usage(db);
		this.triggers = new Triggers(db, this.conversations);
		this.connectors = new Connectors(db, this.crypto, this.triggers, this.signin, { ...(opts.fetchTools ? { fetchTools: opts.fetchTools } : {}), ...(opts.exchange ? { exchange: opts.exchange } : {}) });
		this.apps = new Apps(db, this.signin, { hideSuspended: opts.hideSuspended ?? false });
		this.sharing = new Sharing(db, this.conversations, this.agents, opts.transcripts);
	}
}
