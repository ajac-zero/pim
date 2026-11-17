// A person signing a harness's CLI in with their subscription, in a short-lived workspace of the sandbox manager (`@pim/coding/harness/login`).
// One sign-in per person and harness lives in this process's memory, so a restart ends it and its workspace is deleted; the login the CLI saves goes to the person's vault.
import { cliHarness } from "@pim/coding/harness/index";
import { HarnessLoginFlow, type LoginStatus } from "@pim/coding/harness/login";
import type { WorkspaceProvider } from "@pim/coding/workspace/types";
import { isLoginHarness } from "@pim/shared/harnesses";
import { CapabilityUnavailableError, ForgeError } from "./errors";
import type { LoginFlows } from "./http/vault";
import type { ForgeVault } from "./vault";

export type HarnessLoginsOptions = {
	/** The sandbox manager's workspaces; null when the deployment has none, and every sign-in then answers 503. */
	provider: WorkspaceProvider | null;
	image: string;
	/** The person's vault, read and written under their own row-level security scope. */
	vault: (ownerId: string) => ForgeVault;
	/** After a login is kept: threads that waited for it go on. */
	onConnected?: (ownerId: string, harness: string) => Promise<void>;
};

const none = (harness: string): LoginStatus => ({ harness: harness as never, state: "none", url: null, userCode: null, error: null });

export class HarnessLogins implements LoginFlows {
	private readonly flows = new Map<string, HarnessLoginFlow>();

	constructor(private readonly o: HarnessLoginsOptions) {}

	private cli(harness: string) {
		const cli = isLoginHarness(harness) ? cliHarness(harness) : null;
		if (!cli?.login) throw new ForgeError("not_found", "No sign-in for that harness");
		return cli;
	}

	async start(ownerId: string, harness: string): Promise<LoginStatus> {
		const cli = this.cli(harness);
		if (!this.o.provider) throw new CapabilityUnavailableError("coding:login", "this deployment has no sandbox manager to run the sign-in in");
		await this.cancel(ownerId, harness);
		const key = `${ownerId}\n${harness}`;
		const flow = new HarnessLoginFlow({ harness: cli, userId: ownerId, provider: this.o.provider, image: this.o.image, vault: this.o.vault(ownerId), ...(this.o.onConnected ? { onConnected: () => this.o.onConnected!(ownerId, harness) } : {}) });
		this.flows.set(key, flow);
		return flow.start();
	}

	async status(ownerId: string, harness: string): Promise<LoginStatus> {
		this.cli(harness);
		return this.flows.get(`${ownerId}\n${harness}`)?.status() ?? none(harness);
	}

	async cancel(ownerId: string, harness: string): Promise<LoginStatus> {
		this.cli(harness);
		const key = `${ownerId}\n${harness}`;
		const flow = this.flows.get(key);
		if (flow) {
			await flow.cancel();
			this.flows.delete(key);
		}
		return none(harness);
	}

	/** The code the person pasted, for the harness whose sign-in they have under way (a paste-code sign-in takes it, a device-code one never does). */
	async submitCode(ownerId: string, harness: string, code: string): Promise<LoginStatus> {
		const cli = this.cli(harness);
		if (cli.login?.mode !== "paste_code") throw new ForgeError("invalid", "This sign-in takes no code here: enter it on the sign-in page");
		const flow = this.flows.get(`${ownerId}\n${harness}`);
		return flow ? flow.submit(code) : none(harness);
	}
}
