import { randomBytes } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { App } from "../../src/app.ts";
import { connect } from "../../src/db.ts";
import { migrate } from "../../src/migrate.ts";
import { MemoryBlobStore } from "../../src/objects.ts";
import type { Principal } from "../../src/principal.ts";

/** A fresh database with every migration applied by the owner (a superuser here, as a migration role may be), and an application role that is neither superuser nor BYPASSRLS. */
export async function freshDatabase() {
	const admin = inject("pgAdminUrl");
	const name = `t_${randomBytes(6).toString("hex")}`;
	const root = new pg.Client({ connectionString: admin });
	await root.connect();
	await root.query(`CREATE DATABASE ${name}`);
	await root.end();
	const ownerUrl = admin.replace(/\/postgres$/, `/${name}`);
	await migrate(ownerUrl);
	const appUser = `app_${name}`;
	const owner = new pg.Client({ connectionString: ownerUrl });
	await owner.connect();
	await owner.query(`CREATE ROLE ${appUser} LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS IN ROLE pim_app_rw`);
	await owner.end();
	return { ownerUrl, appUrl: ownerUrl.replace("pim:pim@", `${appUser}:app@`) };
}

export async function fixture() {
	const urls = await freshDatabase();
	const db = connect(urls.appUrl, 4);
	const store = new MemoryBlobStore();
	const app = new App(db, store);
	const admin = await bootstrap(app, "anibal");
	return { ...urls, db, store, app, admin, close: () => db.end() };
}

export const asSession = (ownerId: string, subject = "s1", scopes: string[] = ["*"]): Principal => ({ kind: "session", ownerId, scopes, subject });

/** The first account, made the way an operator does: a bootstrap claim code. */
export async function bootstrap(app: App, username: string) {
	const claim = await app.identity.issueClaim("bootstrap", null, 3600_000);
	const account = await app.identity.register({ username, bootstrap: claim });
	return { account, principal: asSession(account.ownerId, "admin-session") };
}

export async function member(app: App, admin: Principal, username: string) {
	await app.identity.setRegistrationOpen(admin, true);
	const account = await app.identity.register({ username });
	return { account, principal: asSession(account.ownerId, `${username}-session`) };
}
