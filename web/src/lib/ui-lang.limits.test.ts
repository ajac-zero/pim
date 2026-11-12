import { describe, expect, it } from "vitest";
import { compile } from "../../../src/ui-lang/compile";
import {
  evaluate,
  initialState,
  type UiEvent,
} from "../../../src/ui-lang/evaluate";
import {
  MAX_CHART_POINTS,
  MAX_DEPTH,
  MAX_NODES,
  MAX_RESPONSE_STATE_BYTES,
  MAX_SOURCE_BYTES,
  MAX_STATE_BYTES,
  MAX_TEXT_CHARS,
  MAX_TURN_BYTES,
  STEP_BUDGET,
} from "../../../src/ui-lang/limits";
import { extraState, turnFits } from "../../../src/ui-lang/response";
import { checkUiState } from "../../../src/ui-lang/state";

/**
 * Each limit of the ui language, at its exact boundary: what is at the limit
 * works, and one more of it doesn't. The numbers are written out here so a
 * change to a limit is a change to these tests.
 */

const codesOf = (source: string) =>
  compile(source).diagnostics.map((diagnostic) => diagnostic.code);

const run = (source: string, event: UiEvent | null = null) => {
  const program = compile(source);
  return { program, result: evaluate(program, initialState(program), event) };
};

describe("MAX_SOURCE_BYTES", () => {
  it("is 64 KB", () => {
    expect(MAX_SOURCE_BYTES).toBe(65536);
  });

  it("takes a source of exactly that many bytes, and refuses one more", () => {
    const at = compile("a".repeat(MAX_SOURCE_BYTES));
    expect(at.valid).toBe(true);
    expect(at.diagnostics).toEqual([]);
    const over = compile("a".repeat(MAX_SOURCE_BYTES + 1));
    expect(over.valid).toBe(false);
    expect(over.diagnostics.map((d) => d.code)).toEqual(["too_long_source"]);
  });

  it("counts bytes, not characters", () => {
    // "é" is two bytes: half the limit in characters fills it.
    expect(compile("é".repeat(MAX_SOURCE_BYTES / 2)).valid).toBe(true);
    expect(codesOf(`${"é".repeat(MAX_SOURCE_BYTES / 2)}a`)).toContain(
      "too_long_source",
    );
    // Three bytes each, and an emoji four.
    expect(codesOf("€".repeat(Math.floor(MAX_SOURCE_BYTES / 3) + 1))).toContain(
      "too_long_source",
    );
    expect(codesOf("💥".repeat(MAX_SOURCE_BYTES / 4 + 1))).toContain(
      "too_long_source",
    );
  });
});

describe("MAX_NODES", () => {
  it("is 2000", () => {
    expect(MAX_NODES).toBe(2000);
  });

  it("takes exactly that many nodes, and refuses the next", () => {
    const at = compile("<box/>".repeat(MAX_NODES));
    expect(at.valid).toBe(true);
    expect(at.nodes).toHaveLength(MAX_NODES);
    const over = compile("<box/>".repeat(MAX_NODES + 1));
    expect(over.valid).toBe(false);
    expect(over.diagnostics.map((d) => d.code)).toContain("too_many_nodes");
    expect(over.nodes).toHaveLength(MAX_NODES);
  });

  it("counts the text and blocks inside an element too", () => {
    // Each of these is an element and its text: two nodes.
    const at = compile("<text>x</text>".repeat(MAX_NODES / 2));
    expect(at.valid).toBe(true);
    expect(codesOf("<text>x</text>".repeat(MAX_NODES / 2 + 1))).toContain(
      "too_many_nodes",
    );
  });
});

describe("MAX_DEPTH", () => {
  it("is 24", () => {
    expect(MAX_DEPTH).toBe(24);
  });

  const nested = (levels: number) =>
    `${"<box>".repeat(levels)}deepest${"</box>".repeat(levels)}`;

  it("takes elements nested exactly that deep, with their text, and refuses one more", () => {
    const at = compile(nested(MAX_DEPTH));
    expect(at.valid).toBe(true);
    expect(at.fallbackMarkdown).toBe("deepest");
    const over = compile(nested(MAX_DEPTH + 1));
    expect(over.valid).toBe(false);
    expect(over.diagnostics.map((d) => d.code)).toContain("too_deep");
  });

  it("counts blocks as levels too", () => {
    const at = `${"{#if 1}".repeat(MAX_DEPTH)}deepest${"{/if}".repeat(MAX_DEPTH)}`;
    expect(compile(at).valid).toBe(true);
    expect(compile(at).fallbackMarkdown).toBe("deepest");
    const over = `${"{#if 1}".repeat(MAX_DEPTH + 1)}deepest${"{/if}".repeat(MAX_DEPTH + 1)}`;
    expect(codesOf(over)).toContain("too_deep");
  });

  it("is also checked while drawing, to the same depth", () => {
    // A program made by hand, as nothing the compiler gives: if-blocks within if-blocks.
    const program = compile("hi");
    const wrap = (levels: number) => {
      let nodes = program.nodes;
      for (let level = 0; level < levels; level++) {
        nodes = [
          {
            t: "if",
            cond: { t: "bool", v: true },
            then: nodes,
            other: [],
          },
        ];
      }
      return { ...program, nodes };
    };
    const state = initialState(program);
    expect(evaluate(wrap(MAX_DEPTH), state, null).error).toBeNull();
    expect(evaluate(wrap(MAX_DEPTH + 1), state, null).error).toContain(
      "too deeply",
    );
  });
});

describe("STEP_BUDGET", () => {
  it("is 50,000", () => {
    expect(STEP_BUDGET).toBe(50_000);
  });

  /** A block that takes exactly 2k + 1 + lets steps: its list's k + 1, one for each item shown, one per statement. */
  const walk = (items: number, lets: number) =>
    [
      `{#each [${Array(items).fill("1").join(",")}] as n}{n}{/each}`,
      ...Array.from({ length: lets }, (_, index) => `{@let l${index} = 1}`),
    ].join("\n");

  it("takes a block of exactly that many steps, and gives up on one more", () => {
    // (24,999 + 1) + 24,999 + 1 = 50,000.
    const at = run(walk(24_999, 1));
    expect(at.result.error).toBeNull();
    expect(at.program.valid).toBe(true);
    // The same plus one statement: 50,001.
    const over = run(walk(24_999, 2));
    expect(over.result.error).toContain("too many steps");
    expect(over.program.valid).toBe(false);
  });
});

describe("MAX_TEXT_CHARS", () => {
  it("is 2000", () => {
    expect(MAX_TEXT_CHARS).toBe(2000);
  });

  it("shows a text of exactly that many characters, and refuses one more", () => {
    const text = (length: number) => `{@let s = "${"a".repeat(length)}"}\n{s}`;
    const at = run(text(MAX_TEXT_CHARS));
    expect(at.result.error).toBeNull();
    expect(at.program.fallbackMarkdown).toHaveLength(MAX_TEXT_CHARS);
    const over = run(text(MAX_TEXT_CHARS + 1));
    expect(over.result.error).toContain("at most 2000 characters");
  });

  it("limits what a person types the same way", () => {
    const source = '<form id="f"><input name="a"/></form>';
    const type = (length: number) =>
      run(source, {
        type: "change",
        key: "f.a",
        value: "a".repeat(length),
      }).result;
    expect(type(MAX_TEXT_CHARS).error).toBeNull();
    expect(type(MAX_TEXT_CHARS + 1).error).toContain("at most 2000 characters");
  });

  it("limits what state may be kept the same way", () => {
    const program = compile('{@state s = ""}');
    const keep = (length: number) =>
      checkUiState(program, { values: { s: "a".repeat(length) } }).ok;
    expect(keep(MAX_TEXT_CHARS)).toBe(true);
    expect(keep(MAX_TEXT_CHARS + 1)).toBe(false);
  });
});

describe("MAX_STATE_BYTES", () => {
  it("is 32 KB", () => {
    expect(MAX_STATE_BYTES).toBe(32768);
  });

  const bytes = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value)).length;

  it("takes a state of exactly that many bytes while drawing, and refuses one more", () => {
    const empty = bytes(run('{@state s = ""}').result.state);
    const filled = (length: number, letter = "a") =>
      run(`{@state s = "${letter.repeat(length)}"}`);
    const at = filled(MAX_STATE_BYTES - empty);
    expect(bytes(at.result.state)).toBe(MAX_STATE_BYTES);
    expect(at.result.error).toBeNull();
    const over = filled(MAX_STATE_BYTES - empty + 1);
    expect(over.result.error).toContain(`${MAX_STATE_BYTES} bytes`);
    expect(over.program.valid).toBe(false);
  });

  it("counts bytes, as when it is kept", () => {
    const empty = bytes(run('{@state s = ""}').result.state);
    // Two bytes each: half what the characters would fill.
    const at = run(`{@state s = "${"é".repeat((MAX_STATE_BYTES - empty) / 2)}"}`);
    expect(bytes(at.result.state)).toBe(MAX_STATE_BYTES);
    expect(at.result.error).toBeNull();
    const over = run(`{@state s = "${"é".repeat((MAX_STATE_BYTES - empty) / 2)}a"}`);
    expect(over.result.error).not.toBeNull();
  });

  it("takes exactly that many bytes when it is kept, and refuses one more", () => {
    // Sixteen texts of 2000 characters, then the rest in a last one.
    const names = Array.from({ length: 17 }, (_, index) => `s${index}`);
    const program = compile(names.map((name) => `{@state ${name} = ""}`).join("\n"));
    const state = (last: number) => ({
      values: Object.fromEntries(
        names.map((name, index) => [
          name,
          "a".repeat(index < 16 ? MAX_TEXT_CHARS : last),
        ]),
      ),
    });
    const base = bytes({ ...state(0), revealed: {}, submitted: {} });
    const room = MAX_STATE_BYTES - base;
    expect(room).toBeGreaterThan(0);
    expect(room).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(checkUiState(program, state(room)).ok).toBe(true);
    const over = checkUiState(program, state(room + 1));
    expect(over).toEqual({
      ok: false,
      error: `a block's state may be at most ${MAX_STATE_BYTES} bytes`,
    });
  });
});

describe("MAX_TURN_BYTES", () => {
  it("is 16 KB", () => {
    expect(MAX_TURN_BYTES).toBe(16384);
  });

  it("fits exactly that many bytes, and not one more", () => {
    expect(turnFits("a".repeat(MAX_TURN_BYTES))).toBe(true);
    expect(turnFits("a".repeat(MAX_TURN_BYTES + 1))).toBe(false);
    // In bytes: 8192 two-byte characters fill it.
    expect(turnFits("é".repeat(MAX_TURN_BYTES / 2))).toBe(true);
    expect(turnFits(`${"é".repeat(MAX_TURN_BYTES / 2)}a`)).toBe(false);
    expect(turnFits("💥".repeat(MAX_TURN_BYTES / 4 + 1))).toBe(false);
  });
});

describe("MAX_CHART_POINTS", () => {
  it("is 200", () => {
    expect(MAX_CHART_POINTS).toBe(200);
  });

  const chart = (points: number) =>
    run(
      `{@let rows = [${Array.from({ length: points }, (_, index) => `{k: "p${index}", v: ${index}}`).join(",")}]}\n<chart kind="line" data={rows} x="k" y="v"/>`,
    );

  it("draws exactly that many points, and refuses one more", () => {
    const at = chart(MAX_CHART_POINTS);
    expect(at.result.error).toBeNull();
    const drawn = at.result.tree.find(
      (node) => node.t === "el" && node.tag === "chart",
    );
    expect(drawn?.t === "el" && (drawn.props.data as unknown[]).length).toBe(
      MAX_CHART_POINTS,
    );
    const over = chart(MAX_CHART_POINTS + 1);
    expect(over.result.error).toContain("at most 200 points");
    expect(over.program.valid).toBe(false);
  });

  it("limits a chart of plain numbers the same way", () => {
    const numbers = (points: number) =>
      run(`<chart kind="bar" data={[${Array(points).fill("1").join(",")}]}/>`);
    expect(numbers(MAX_CHART_POINTS).result.error).toBeNull();
    expect(numbers(MAX_CHART_POINTS + 1).result.error).toContain(
      "at most 200 points",
    );
  });
});

describe("MAX_RESPONSE_STATE_BYTES, the state a form's turn carries", () => {
  it("is 4 KB", () => {
    expect(MAX_RESPONSE_STATE_BYTES).toBe(4096);
  });

  const names = ["a", "b", "c"];
  const program = compile(names.map((name) => `{@state ${name} = ""}`).join("\n"));
  const carried = (last: number) => {
    const values = {
      a: "x".repeat(MAX_TEXT_CHARS),
      b: "y".repeat(MAX_TEXT_CHARS - 100),
      c: "z".repeat(last),
    };
    return extraState(program, { values, revealed: {}, submitted: {} });
  };
  const bytes = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value)).length;

  it("carries a state whose JSON is exactly that many bytes, and drops the key that would pass it", () => {
    const withoutLast = bytes({
      a: "x".repeat(MAX_TEXT_CHARS),
      b: "y".repeat(MAX_TEXT_CHARS - 100),
      c: "",
    });
    const room = MAX_RESPONSE_STATE_BYTES - withoutLast;
    expect(room).toBeGreaterThan(0);
    const at = carried(room);
    expect(Object.keys(at)).toEqual(["a", "b", "c"]);
    expect(bytes(at)).toBe(MAX_RESPONSE_STATE_BYTES);
    const over = carried(room + 1);
    expect(Object.keys(over)).toEqual(["a", "b"]);
    expect(bytes(over)).toBeLessThanOrEqual(MAX_RESPONSE_STATE_BYTES);
  });
});
