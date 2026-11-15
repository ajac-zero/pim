import { describe, expect, it } from "vitest";
import { type DirectoryApp, findApps } from "../src/extensions/app-directory";

const app = (ref: string, name: string, description = ""): DirectoryApp => ({ ref, name, description, url: `https://${ref.replace("/", ".")}.test/mcp`, custom: false, icon: null, category: null });

describe("findApps", () => {
	it("puts the app named as asked first, then names with every word, then some, then descriptions, and nothing else", () => {
		const directory = [
			app("x/journal", "Journal", "Daily notes and reflections."),
			app("x/apple-notes", "Apple Notes"),
			app("x/notes-sync", "Sync for Notes and Docs"),
			app("x/linear", "Linear", "Issues."),
			app("x/notes", "Notes"),
		];
		expect(findApps(directory, "notes").map((found) => found.ref)).toEqual(["x/notes", "x/apple-notes", "x/notes-sync", "x/journal"]);
		expect(findApps(directory, "Apple notes").map((found) => found.ref)).toEqual(["x/apple-notes", "x/notes-sync", "x/notes", "x/journal"]);
		expect(findApps(directory, "spotify")).toEqual([]);
	});
});
