import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CATALOG_VERSION,
  UI_EXAMPLE,
  uiBlockReference,
} from "../../../src/ui-lang/catalog";
import { compile } from "../../../src/ui-lang/compile";
import { evaluate, initialState } from "../../../src/ui-lang/evaluate";
import type { Node, UiProgram } from "../../../src/ui-lang/program";
import {
  splitUiResponse,
  uiResponseOf,
  uiTurn,
} from "../../../src/ui-lang/response";

/** The example the whole feature must handle, as a block's source. */
const EXAMPLE = UI_EXAMPLE;

/** A block compiled, which these tests mostly work from. */
const programOf = (source: string): UiProgram => compile(source);

/** A block evaluated from scratch, once or with an event in between. */
const drawn = (
  source: string,
  event?: Parameters<typeof evaluate>[2],
  given?: UiProgram,
) => {
  const program = given ?? programOf(source);
  const first = evaluate(program, initialState(program), event ?? null);
  if (first.error !== null) throw new Error(first.error);
  return { program, ...first };
};

/** The text a block draws, its nodes flattened to what they say. */
const textOf = (tree: ReturnType<typeof evaluate>["tree"]): string[] =>
  tree.flatMap((node) => {
    if (node.t === "el") return textOf(node.children);
    return [node.text];
  });

describe("the ui language's parser", () => {
  it("lays the example out as a program with stable keys", () => {
    const program = programOf(EXAMPLE);
    expect(program.diagnostics).toEqual([]);
    expect(program.valid).toBe(true);
    expect(program.version).toBe(CATALOG_VERSION);
    expect(Object.keys(program.forms)).toEqual(["knn"]);
    const form = program.forms.knn ?? { fields: [] };
    expect(form.fields.map((field) => field.key)).toEqual([
      "knn.d1",
      "knn.d2",
      "knn.pred",
    ]);
    expect(form.fields.map((field) => field.graded)).toEqual([
      true,
      true,
      true,
    ]);
    expect(program.stateKeys).toEqual(["knn.d1", "knn.d2", "knn.pred"]);
    // The block's text lives in a table beside the JSON, each stretch once.
    expect(program.texts).toContain("(1, 1)");
    expect(program.texts).toContain("Score: ");
    // The form and each of its fields carries the key that names its state.
    const formNode = program.nodes[0];
    if (formNode?.t !== "el")
      throw new Error("the example begins with its form");
    expect(formNode.tag).toBe("form");
    expect(formNode.key).toBe("knn");
    expect(formNode.props.onSubmit?.k).toBe("actions");
    const table = formNode.children.find(
      (child): child is Extract<Node, { t: "el" }> =>
        child.t === "el" && child.tag === "table",
    );
    expect(table?.tag).toBe("table");
  });

  it("keeps every line the model wrote, when it parses at all, cut off anywhere", () => {
    for (let cut = 0; cut <= EXAMPLE.length; cut++) {
      const prefix = EXAMPLE.slice(0, cut);
      const program = programOf(prefix);
      // Whatever the cut left, the block either draws or says what's wrong with it.
      if (program.valid) expect(program.fallbackMarkdown).toBeDefined();
      else expect(program.diagnostics.length).toBeGreaterThan(0);
      // And it never throws, however it was cut.
      expect(() =>
        evaluate(program, initialState(program), null),
      ).not.toThrow();
    }
  });
});

describe("the ui language's validator", () => {
  it("refuses a component the catalog doesn't have", () => {
    const program = programOf("<box><chart/></box>");
    expect(program.valid).toBe(false);
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: "unknown_tag", severity: "error" }),
    );
  });

  it("drops a prop the component doesn't take, and says so", () => {
    const program = programOf("<box gap={2} fancy={1}>Hi</box>");
    expect(program.valid).toBe(true);
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: "unknown_prop" }),
    );
    const box = program.nodes[0];
    if (box?.t === "el") expect(Object.keys(box.props)).toEqual(["gap"]);
  });

  it("drops a value that doesn't fit its prop", () => {
    const program = programOf('<box padding="3">Hi</box>');
    expect(program.valid).toBe(true);
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "invalid_literal",
        message: expect.stringContaining("padding"),
      }),
    );
    const box = program.nodes[0];
    if (box?.t === "el") expect(box.props.padding).toBeUndefined();
  });

  it("drops a tone that isn't one, and a form with no id", () => {
    const program = programOf('<text tone="loud">Hi</text>');
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: "invalid_literal" }),
    );
    const formless = programOf("<form></form>");
    expect(formless.valid).toBe(false);
    expect(formless.diagnostics).toContainEqual(
      expect.objectContaining({ code: "missing_prop", severity: "error" }),
    );
  });

  it("refuses a field outside a form, a second form of one name and a nest of forms", () => {
    expect(programOf('<number name="n"/>').diagnostics).toContainEqual(
      expect.objectContaining({ code: "orphan_field", severity: "error" }),
    );
    const twice = programOf('<form id="a"></form><form id="a"></form>');
    expect(twice.diagnostics).toContainEqual(
      expect.objectContaining({ code: "duplicate_form" }),
    );
    const nested = programOf('<form id="a"><form id="b"></form></form>');
    expect(nested.diagnostics).toContainEqual(
      expect.objectContaining({ code: "nested_form" }),
    );
  });

  it("refuses what is over its limits", () => {
    const long = programOf(`${"<box>".repeat(64 * 1024)}`);
    expect(long.valid).toBe(false);
    expect(long.diagnostics).toContainEqual(
      expect.objectContaining({ code: "too_long_source" }),
    );
    const deep = programOf(`${"<box>".repeat(40)}Hi${"</box>".repeat(40)}`);
    expect(deep.diagnostics).toContainEqual(
      expect.objectContaining({ code: "too_deep" }),
    );
    const many = programOf("<text>x</text>".repeat(2500));
    expect(many.valid).toBe(false);
    expect(many.diagnostics).toContainEqual(
      expect.objectContaining({ code: "too_many_nodes" }),
    );
  });
});

describe("the ui language's interpreter", () => {
  it("works out arithmetic, strings and the builtins", () => {
    const source = [
      "{1 + 2 * 3}",
      "{10 % 3}",
      '{"a" + 1}',
      "{abs(-5)}",
      "{min(3, 1, 2)}",
      "{round(2.5)}",
      '{len("abc")}',
      '{join(["a", "b"], "-")}',
      "{close(1, 1.02, 0.05)}",
    ].join(" ");
    expect(textOf(drawn(source).tree).join(" ")).toEqual(
      "7 1 a1 5 1 3 3 a-b true",
    );
  });

  it("holds state the block declares, and derives what it derives", () => {
    const source = [
      "{@state seats = 8}",
      "{@let price = seats * 29}",
      "Seats: {seats}",
      "Price: {price}",
    ].join("\n");
    const first = drawn(source);
    expect(textOf(first.tree).join("")).toContain("Seats: 8");
    expect(textOf(first.tree).join("")).toContain("Price: 232");
    const second = evaluate(first.program, first.state, {
      type: "change",
      key: "seats",
      value: "4",
    });
    expect(second.error).toBeNull();
    expect(textOf(second.tree).join("")).toContain("Seats: 4");
    expect(textOf(second.tree).join("")).toContain("Price: 116");
  });

  it("takes a branch, and walks a list", () => {
    expect(textOf(drawn("{#if 2 > 1}yes{:else}no{/if}").tree)).toEqual(["yes"]);
    expect(
      textOf(
        drawn('{#each ["a", "b"] as letter, i}{i}: {letter};{/each}').tree,
      ),
    ).toEqual(["0: a;", "1: b;"]);
    expect(textOf(drawn("{#if false}yes{:else}no{/if}").tree)).toEqual(["no"]);
  });

  it("checks, locks and summarizes a submitted form, and asks for its turn", () => {
    const program = programOf(EXAMPLE);
    let state = initialState(program);
    for (const [key, value] of [
      ["knn.d1", "5"],
      ["knn.d2", "13.005"],
      ["knn.pred", "A"],
    ] as const) {
      const step = evaluate(program, state, { type: "change", key, value });
      expect(step.error).toBeNull();
      state = step.state;
    }
    const submitted = evaluate(program, state, { type: "submit", form: "knn" });
    expect(submitted.error).toBeNull();
    expect(submitted.state.submitted.knn?.graded).toEqual({
      "knn.d1": true,
      "knn.d2": true,
      "knn.pred": true,
    });
    // The handler's actions come back as data, in order.
    expect(submitted.actions).toEqual([
      { name: "reveal", args: [], form: "knn" },
      {
        name: "issueNewTurn",
        args: [expect.stringContaining("| d1 | 5 ✓ |")],
        form: "knn",
      },
    ]);
    const summary = submitted.actions.find(
      (action) => action.name === "issueNewTurn",
    )?.args[0];
    expect(summary).toContain("Form knn");
    expect(summary).toContain("| Predicted label | A ✓ |");
    expect(summary).toContain("Score: 3 / 3");
    // What it drew says so too, once it's submitted.
    expect(textOf(submitted.tree)).toContain("Score: 3 / 3");
  });

  it("marks a wrong answer, and counts only what it can check", () => {
    const source = [
      '<form id="q" onSubmit={[reveal()]}>',
      '  <number name="n" answer={2}/>',
      '  <input name="city" answer=" Lisbon "/>',
      '  <select name="pick" options={["a", "b"]}/>',
      "</form>",
    ].join("\n");
    const program = programOf(source);
    let state = initialState(program);
    for (const [key, value] of [
      ["q.n", "3"],
      ["q.city", "  LISBON "],
      ["q.pick", "a"],
    ] as const) {
      const step = evaluate(program, state, { type: "change", key, value });
      expect(step.error).toBeNull();
      state = step.state;
    }
    const submitted = evaluate(program, state, { type: "submit", form: "q" });
    expect(submitted.state.submitted.q?.graded).toEqual({
      "q.n": false,
      "q.city": true,
    });
    expect(submitted.actions).toEqual([
      { name: "reveal", args: [], form: "q" },
    ]);
  });

  it("keeps an answer off the page until the form is revealed", () => {
    const program = programOf(EXAMPLE);
    let filled = initialState(program);
    for (const [key, value] of [
      ["knn.d1", "5"],
      ["knn.d2", "12"],
      ["knn.pred", "A"],
    ] as const) {
      filled = evaluate(program, filled, { type: "change", key, value }).state;
    }
    const before = evaluate(program, filled, null);
    expect(JSON.stringify(before.tree)).not.toContain("13");
    expect(JSON.stringify(before.tree)).not.toContain("(2-1)²+(3-1)²");
    const after = evaluate(program, before.state, {
      type: "submit",
      form: "knn",
    });
    const json = JSON.stringify(after.tree);
    expect(json).toContain("13");
    expect(json).toContain("(2-1)²+(3-1)²");
  });

  it("makes every field required unless it says required={false}", () => {
    const program = programOf(
      [
        '<form id="f">',
        '  <number name="n"/><input name="a"/><input name="b" required={false}/>',
        '  <select name="s" options={["x", "y"]}/>',
        "</form>",
      ].join("\n"),
    );
    expect(program.forms.f?.fields.map((field) => field.required)).toEqual([
      true,
      true,
      false,
      true,
    ]);
    const ready = (values: Record<string, string>) => {
      let state = initialState(program);
      for (const [key, value] of Object.entries(values)) {
        state = evaluate(program, state, { type: "change", key, value }).state;
      }
      const form = evaluate(program, state, null).tree.find(
        (node) => node.t === "el" && node.tag === "form",
      );
      return form?.t === "el" ? form.props.ready : undefined;
    };
    expect(ready({})).toBe(false);
    expect(ready({ "f.n": "1", "f.a": "x" })).toBe(false);
    expect(ready({ "f.n": "abc", "f.a": "x", "f.s": "y" })).toBe(false);
    expect(ready({ "f.n": "Infinity", "f.a": "x", "f.s": "y" })).toBe(false);
    expect(ready({ "f.n": "1", "f.a": "  ", "f.s": "y" })).toBe(false);
    expect(ready({ "f.n": "1.5", "f.a": "x", "f.s": "y" })).toBe(true);
    const submitted = evaluate(program, initialState(program), {
      type: "submit",
      form: "f",
    });
    expect(submitted.error).toBe("Fill in every field to submit.");
  });

  it("gives up on a block that takes too many steps, without throwing", () => {
    const list = `[${Array(30000).fill("1").join(",")}]`;
    const source = `{#each ${list} as n}{n}{/each}`;
    const program = programOf(source);
    const result = evaluate(program, initialState(program), null);
    expect(result.error).toContain("steps");
  });

  it("keeps the interpreter's own machinery out of reach", () => {
    // A property the language may not name doesn't parse, and is said.
    const refused = [
      "{[1].constructor}",
      '{[1]["__proto__"]}',
      '{ {"__proto__": 1}["x"] }',
      '{@state items = [1]}\n{items["0"]["constructor"]}',
    ];
    for (const source of refused) {
      const program = programOf(source);
      expect(
        program.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "invalid_expression" ||
            diagnostic.code === "unterminated_statement",
        ),
        source,
      ).toBe(true);
    }
    // A name that is worked out at run time is refused there, with an error and no throw.
    const probe = programOf(
      '{@state items = [1]}\n{@let which = "constructor"}\n{items["0"][which]}',
    );
    const result = evaluate(probe, initialState(probe), null);
    expect(result.error).toContain("not the block's to read");
  });

  it("reveals a form's answers when its button is clicked", () => {
    const source =
      '<form id="q"><input name="city" answer="Rome"/><button onClick={[reveal()]}>Show me</button></form>';
    const program = programOf(source);
    const before = evaluate(program, initialState(program), null);
    expect(JSON.stringify(before.tree)).not.toContain("Rome");
    // The click asks for the reveal, as data; the app runs it.
    const clicked = evaluate(program, before.state, {
      type: "click",
      key: "b0",
    });
    expect(clicked.actions).toEqual([{ name: "reveal", args: [], form: "q" }]);
    const shown = evaluate(program, clicked.state, {
      type: "reveal",
      form: "q",
    });
    expect(shown.error).toBeNull();
    expect(JSON.stringify(shown.tree)).toContain("Rome");
  });

  it("gives the same answer every time", () => {
    const source = EXAMPLE;
    const program = programOf(source);
    const once = evaluate(program, initialState(program), {
      type: "submit",
      form: "knn",
    });
    const twice = evaluate(program, initialState(program), {
      type: "submit",
      form: "knn",
    });
    expect(twice).toEqual(once);
  });

  it("refuses a handler that isn't a list of actions", () => {
    const program = programOf('<button onClick={copy("x")}>Copy</button>');
    expect(program.diagnostics).toContainEqual(
      expect.objectContaining({ code: "invalid_actions" }),
    );
    const right = programOf('<button onClick={[copy("x")]}>Copy</button>');
    expect(right.diagnostics).toEqual([]);
    const wrongBuiltin = programOf(
      '<button onClick={[str("x")]}>Copy</button>',
    );
    expect(wrongBuiltin.diagnostics).toContainEqual(
      expect.objectContaining({ code: "invalid_actions" }),
    );
  });
});

describe("the ui language's fallback", () => {
  it("reads as Markdown, with the answers as blanks", () => {
    const program = programOf(EXAMPLE);
    expect(program.fallbackMarkdown).toBe(
      [
        "Form knn",
        "",
        "| Point | Label | d² |",
        "| --- | --- | --- |",
        "| (1, 1) | A | ___ |",
        "| (4, 5) | B | ___ |",
        "",
        "- Predicted label: ___",
      ].join("\n"),
    );
    // Neither the answers nor their explanations are in it.
    expect(program.fallbackMarkdown).not.toContain("13");
    expect(program.fallbackMarkdown).not.toContain("(2-1)²+(3-1)²");
  });

  it("shows what a block worked out, and its headings and boxes", () => {
    const source = [
      "A heading",
      "",
      "<title>Seats</title>",
      '<box row={true} gap={2}><text tone="muted">Two</text><text>Three</text></box>',
      "{@state seats = 4}",
      "{seats + 1} seats",
    ].join("\n");
    const program = programOf(source);
    expect(program.fallbackMarkdown).toBe(
      ["A heading", "## Seats", "Two\n\nThree", "5 seats"].join("\n\n"),
    );
  });
});

describe("the ui-response trailer", () => {
  const response = {
    block: "knn",
    messageId: "m1",
    values: { "knn.d1": "5" },
    graded: { "knn.d1": true },
  };
  const turn = uiTurn(
    "| Field | Answer |\n| --- | --- |\n| d1 | 5 ✓ |\n\nScore: 1 / 1",
    response,
  );

  it("rides in a fence, and comes back out whole", () => {
    expect(uiResponseOf(turn)).toEqual(response);
    const split = splitUiResponse(turn);
    expect(split?.readable).toBe(
      "| Field | Answer |\n| --- | --- |\n| d1 | 5 ✓ |\n\nScore: 1 / 1",
    );
    expect(split?.response.block).toBe("knn");
  });

  it("keeps a fence that only looks like one, and a broken one, out", () => {
    expect(uiResponseOf("```ui-response\n{nope\n```")).toBeNull();
    expect(uiResponseOf("```ui-response\n[]\n```")).toBeNull();
    expect(uiResponseOf("Nothing to see.")).toBeNull();
  });
});

describe("the ui language's own code", () => {
  it("runs nothing of the model's: no eval, no new Function", () => {
    const files = readdirSync(
      new URL("../../../src/ui-lang", import.meta.url),
      {
        recursive: true,
        encoding: "utf8",
      },
    ).filter((file) => file.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(
        new URL(`../../../src/ui-lang/${file}`, import.meta.url),
        "utf8",
      );
      expect(source, file).not.toMatch(/\beval\s*\(/);
      expect(source, file).not.toMatch(/new\s+Function/);
    }
  });

  it("describes the catalog to the model, from the catalog", () => {
    const reference = uiBlockReference();
    expect(reference).toContain("required?={true}");
    expect(reference).toContain("<form");
    expect(reference).toContain("reveal()");
    expect(reference).toContain("formSummary");
    expect(reference).toContain(EXAMPLE);
  });
});
