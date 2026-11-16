import { Canvas } from "./canvas.ts";
import { Conversations } from "./conversations.ts";
import { type Db } from "./db.ts";
import { Identity } from "./identity.ts";
import { Memories } from "./memory.ts";
import { Approvals, Operations } from "./operations.ts";
import type { ObjectStore } from "@pim/v2-contracts/platform";
import { Objects } from "./objects.ts";
import { Relay } from "./relay.ts";
import { Schedules } from "./schedules.ts";

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
	constructor(readonly db: Db, store: ObjectStore, opts: { hideSuspended?: boolean } = {}) {
		this.identity = new Identity(db);
		this.conversations = new Conversations(db);
		this.memories = new Memories(db);
		this.schedules = new Schedules(db, this.conversations);
		this.operations = new Operations(db);
		this.approvals = new Approvals(db);
		this.objects = new Objects(db, store, opts);
		this.canvas = new Canvas(db, store);
		this.relay = new Relay(db, this.identity);
	}
}
