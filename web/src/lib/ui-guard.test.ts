import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("the ui language's own code, and the app's that draws it", () => {
  /** What nothing that draws a model's block may use: each runs, or injects, what it is given as code or markup. */
  const FORBIDDEN: Record<string, RegExp> = {
    eval: /\beval\s*\(/,
    "new Function": /\bnew\s+Function\b/,
    "Function()": /(^|[^.\w])Function\s*\(/,
    // A lazy import of the app's own file, by a plain string, splits the bundle; one that is worked out could load anything.
    "dynamic import of a computed address":
      /\bimport\s*\(\s*(?!["'][^"'+]*["']\s*\))/,
    innerHTML: /\binnerHTML\b/,
    outerHTML: /\bouterHTML\b/,
    dangerouslySetInnerHTML: /dangerouslySetInnerHTML/,
    insertAdjacentHTML: /insertAdjacentHTML/,
    "document.write": /document\s*\.\s*write/,
    "setTimeout of a string": /\bset(Timeout|Interval)\s*\(\s*["'`]/,
  };

  /** A file's code without its comments, which may say what the code never does. */
  const codeOf = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  /** The files that draw or run a block: all of the shared module, and the app's ui-* components, tests aside. */
  const guarded = () => {
    const shared = pathToFileURL(
      `${dirname(createRequire(import.meta.url).resolve("@pim/ui-lang"))}/`,
    );
    const chat = new URL("../components/chat/", import.meta.url);
    const files = [
      ...readdirSync(shared, { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".ts"))
        .map((file) => new URL(file, shared)),
      ...readdirSync(chat, { encoding: "utf8" })
        .filter((file) => /^ui-.*\.tsx?$/.test(file) && !/\.test\./.test(file))
        .map((file) => new URL(file, chat)),
      new URL("../lib/ui-state.ts", import.meta.url),
    ];
    return files.map((url) => ({
      file: url.pathname.split("/").slice(-2).join("/"),
      code: codeOf(readFileSync(url, "utf8")),
    }));
  };

  it("runs nothing of the model's and injects no markup: no eval, new Function, computed dynamic import or innerHTML", () => {
    const files = guarded();
    // The scan sees the whole module and both of the web's ui files.
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((entry) => entry.file)).toEqual(
      expect.arrayContaining([
        "src/evaluate.ts",
        "src/parse.ts",
        "chat/ui-block.tsx",
        "chat/ui-chart.tsx",
      ]),
    );
    for (const { file, code } of files) {
      for (const [name, pattern] of Object.entries(FORBIDDEN)) {
        expect(pattern.test(code), `${file} uses ${name}`).toBe(false);
      }
    }
  });

  it("would notice each of them", () => {
    const bad: Record<string, string> = {
      eval: 'eval("1")',
      "new Function": 'new Function("return 1")',
      "Function()": 'Function("return 1")()',
      "dynamic import of a computed address": "await import(address)",
      innerHTML: "node.innerHTML = html",
      outerHTML: "node.outerHTML = html",
      dangerouslySetInnerHTML:
        "<div dangerouslySetInnerHTML={{ __html: x }} />",
      insertAdjacentHTML: 'node.insertAdjacentHTML("beforeend", x)',
      "document.write": "document.write(x)",
      "setTimeout of a string": 'setTimeout("run()", 1)',
    };
    expect(Object.keys(bad).sort()).toEqual(Object.keys(FORBIDDEN).sort());
    for (const [name, line] of Object.entries(bad)) {
      expect(FORBIDDEN[name]?.test(codeOf(line)), name).toBe(true);
    }
    for (const line of [
      'import("./" + name)',
      "import(`./" + "$" + "{name}`)",
    ]) {
      expect(
        FORBIDDEN["dynamic import of a computed address"]?.test(line),
        line,
      ).toBe(true);
    }
    // And what only talks about them, or merely looks alike, passes.
    const fine = [
      "// never eval( anything",
      "/* new Function */ const a = 1;",
      "evaluate(program, state, null)",
      "import type { X } from './x'",
      'const Chart = lazy(() => import("~/components/chat/ui-chart"))',
      "import.meta.env.DEV",
      "const text = el.textContent",
      "program.nodes.map(Function.prototype)",
    ];
    for (const line of fine) {
      for (const [name, pattern] of Object.entries(FORBIDDEN)) {
        expect(pattern.test(codeOf(line)), `${line} as ${name}`).toBe(false);
      }
    }
  });
});
