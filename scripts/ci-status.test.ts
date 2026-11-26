import { describe, expect, it } from "vitest";
import { ciStatus } from "./ci-status.mjs";

// `gh run list` for the two workflows, by what each says.
const gh = (ci: object[], compose: object[]) => (args: string[]) => JSON.stringify(args.includes("ci.yml") ? ci : compose);
const done = (conclusion: string) => ({ status: "completed", conclusion });

describe("whether CI and the Compose smoke test passed on a commit", () => {
	it("is success only when both completed successfully", () => {
		expect(ciStatus("c", gh([done("success")], [done("success")]))).toBe("success");
	});
	it("is pending until both have started and finished, and failed as soon as one failed", () => {
		expect(ciStatus("c", gh([done("success")], []))).toBe("pending");
		expect(ciStatus("c", gh([{ status: "in_progress", conclusion: null }], [done("success")]))).toBe("pending");
		expect(ciStatus("c", gh([done("failure")], []))).toBe("failed");
		expect(ciStatus("c", gh([done("success")], [done("cancelled")]))).toBe("failed");
	});
	it("asks about the push to main of the commit, and an unreadable answer is an error, not a pass", () => {
		const asked: string[][] = [];
		ciStatus("abc", (args: string[]) => (asked.push(args), JSON.stringify([done("success")])));
		expect(asked[0]).toEqual(expect.arrayContaining(["--commit", "abc", "--event", "push", "--branch", "main"]));
		expect(() => ciStatus("c", () => "oops")).toThrow();
		expect(() => ciStatus("c", () => { throw new Error("rate limited"); })).toThrow();
	});
});
