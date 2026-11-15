// Reading how many tests passed and failed out of a test run's output, for the formats test runners commonly print: JUnit XML, TAP, vitest, pytest and cargo. A format that is not recognized gives no summary; the run's exit code still says whether it passed.

/** What a test run reports: the format it was read from, and its counts. `failed` includes errors; `skipped` includes todo and expected failures. */
export type TestSummary = {
	format: "junit" | "tap" | "vitest" | "pytest" | "cargo";
	passed: number;
	failed: number;
	skipped: number;
	total: number;
};

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** The summary `output` holds, or undefined when no known format is found in it. Where a runner prints several summaries, as cargo does for each crate, they are added up. */
export function parseTestSummary(output: string): TestSummary | undefined {
	const text = output.replace(ANSI, "").replace(/\r\n?/g, "\n");
	return junit(text) ?? cargo(text) ?? vitest(text) ?? pytest(text) ?? tap(text);
}

const summary = (format: TestSummary["format"], passed: number, failed: number, skipped: number): TestSummary => ({
	format,
	passed,
	failed,
	skipped,
	total: passed + failed + skipped,
});

function attribute(tag: string, name: string): number {
	const match = tag.match(new RegExp(`\\s${name}="(\\d+)"`));
	return match ? Number(match[1]) : 0;
}

/** A JUnit XML report: the `<testsuites>` totals when they are given, otherwise the sum of every `<testsuite>`. */
function junit(text: string): TestSummary | undefined {
	const suites = text.match(/<testsuites\b[^>]*>/);
	const tags = suites && /\stests="/.test(suites[0]) ? [suites[0]] : (text.match(/<testsuite\b[^>]*>/g) ?? []);
	if (tags.length === 0) return undefined;
	let tests = 0;
	let failed = 0;
	let skipped = 0;
	for (const tag of tags) {
		tests += attribute(tag, "tests");
		failed += attribute(tag, "failures") + attribute(tag, "errors");
		skipped += attribute(tag, "skipped") + attribute(tag, "disabled");
	}
	return summary("junit", Math.max(0, tests - failed - skipped), failed, skipped);
}

/** `test result: ok. 3 passed; 1 failed; 2 ignored; ...`, once for each test binary. */
function cargo(text: string): TestSummary | undefined {
	const results = [...text.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored;/gm)];
	if (results.length === 0) return undefined;
	const sum = (index: number) => results.reduce((total, match) => total + Number(match[index]), 0);
	return summary("cargo", sum(1), sum(2), sum(3));
}

/** Vitest's ` Tests  1 failed | 3 passed | 2 skipped (6)`; the last one, as watch mode prints one per run. */
function vitest(text: string): TestSummary | undefined {
	const line = [...text.matchAll(/^\s*Tests\s{2,}(.+?)\s+\(\d+\)\s*$/gm)].pop();
	if (!line) return undefined;
	const count = (word: RegExp) => [...(line[1] ?? "").matchAll(new RegExp(`(\\d+) ${word.source}`, "g"))].reduce((total, match) => total + Number(match[1]), 0);
	return summary("vitest", count(/passed/), count(/failed/), count(/(?:skipped|todo)/));
}

/** Pytest's last line, `==== 2 failed, 10 passed, 1 skipped in 0.12s ====`, with or without the rules. */
function pytest(text: string): TestSummary | undefined {
	const line = [...text.matchAll(/^=*\s*((?:\d+ \w+,? ?)+|no tests ran) in [\d.]+s\b.*$/gm)].pop();
	if (!line) return undefined;
	const counts: Record<string, number> = {};
	for (const [, n, word] of (line[1] ?? "").matchAll(/(\d+) (\w+)/g)) counts[word ?? ""] = (counts[word ?? ""] ?? 0) + Number(n);
	const get = (...words: string[]) => words.reduce((total, word) => total + (counts[word] ?? 0), 0);
	if (line[1] !== "no tests ran" && get("passed", "failed", "skipped", "error", "errors", "xfailed", "xpassed") === 0) return undefined;
	return summary("pytest", get("passed", "xpassed"), get("failed", "error", "errors"), get("skipped", "xfailed"));
}

/** TAP: the `# pass`, `# fail` and `# skip` totals some producers print at the end, otherwise its top-level `ok` and `not ok` lines. Needs a plan (`1..N`) or a version line, so stray "ok" lines elsewhere are not mistaken for it. */
function tap(text: string): TestSummary | undefined {
	if (!/^(?:TAP version \d+|\s*1\.\.\d+)\s*$/m.test(text)) return undefined;
	const total = (word: string) => {
		const match = text.match(new RegExp(`^# ${word} (\\d+)\\s*$`, "m"));
		return match ? Number(match[1]) : undefined;
	};
	const [pass, fail] = [total("pass"), total("fail")];
	if (pass !== undefined && fail !== undefined) return summary("tap", pass, fail, (total("skipped") ?? total("skip") ?? 0) + (total("todo") ?? 0));
	let passed = 0;
	let failed = 0;
	let skipped = 0;
	for (const [, not, rest] of text.matchAll(/^(not )?ok\b(.*)$/gm)) {
		if (/#\s*(?:skip|todo)\b/i.test(rest ?? "")) skipped++;
		else if (not) failed++;
		else passed++;
	}
	return summary("tap", passed, failed, skipped);
}
