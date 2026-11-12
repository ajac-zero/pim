import { describe, expect, it } from "vitest";
import { UI_EXAMPLE } from "../../../src/ui-lang/catalog";
import { compile } from "../../../src/ui-lang/compile";
import {
  evaluate,
  initialState,
  type UiEvent,
} from "../../../src/ui-lang/evaluate";
import { MAX_SOURCE_BYTES } from "../../../src/ui-lang/limits";

/**
 * Fuzzing the ui language: valid programs mutated at random and cut off at
 * every character, then compiled, drawn and driven with events. Whatever the
 * source, nothing may throw and every case must finish quickly. The
 * generator is seeded, so a failure names the seed and replays.
 */

/** A small seeded generator (mulberry32), so every run sees the same cases. */
function seeded(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (below: number) => Math.floor(next() * below);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  return { next, int, pick };
}
type Random = ReturnType<typeof seeded>;

const CALCULATOR = [
  "{@state seats = 8}",
  '<slider name="seats" label="Seats" min={1} max={50} unit="seats"/>',
  '<checkbox name="annual" label="Annual billing"/>',
  "{@let price = annual ? seats * 24 : seats * 29}",
  "<text>{seats} seats cost {price}</text>",
].join("\n");

const CHART = [
  "{@state seats = 2}",
  '<slider name="seats" label="Seats" min={1} max={10}/>',
  "{@let rows = [{plan: 'Solo', cost: seats * 10}, {plan: 'Team', cost: seats * 25}]}",
  '<chart kind="bar" title="Monthly cost" data={rows} x="plan" y="cost"/>',
  '<badge tone="warn">Estimate</badge>',
  "{#each rows as row, i}<text>{i}: {row.plan} {row.cost}</text>{/each}",
  '<button onClick={[copy("x"), issueNewTurn("hi")]}>Copy</button>',
].join("\n");

const CORPUS = { knn: UI_EXAMPLE, calculator: CALCULATOR, chart: CHART };

/** Pieces of the language and of what attacks it, to splice in. */
const TOKENS = [
  "{",
  "}",
  "<",
  ">",
  "</box>",
  "</form>",
  "/>",
  '"',
  "'",
  "\\",
  "\n",
  "{#if 1}",
  "{:else}",
  "{/if}",
  "{#each [1,2] as x, i}",
  "{/each}",
  "{@state a = 1}",
  "{@let b = a + 1}",
  "<box>",
  '<form id="f">',
  '<number name="n"/>',
  "__proto__",
  "constructor",
  "prototype",
  "[",
  "]",
  "(",
  ")",
  "?",
  ":",
  "&&",
  "||",
  "!",
  "-",
  "%",
  "/",
  "1e999",
  "0.1e-999",
  "\u0000",
  "\u202e",
  "💥",
  "sum(",
  "map(",
  'formSummary("knn")',
  "{{{{",
  "}}}}",
];

function mutate(random: Random, source: string): string {
  let text = source;
  const rounds = 1 + random.int(6);
  for (let round = 0; round < rounds; round++) {
    const at = random.int(text.length + 1);
    switch (random.int(7)) {
      case 0: // delete a range
        text = text.slice(0, at) + text.slice(at + random.int(20));
        break;
      case 1: // insert a token
        text = text.slice(0, at) + random.pick(TOKENS) + text.slice(at);
        break;
      case 2: // replace a character
        text =
          text.slice(0, at) +
          String.fromCharCode(random.int(0x2fff)) +
          text.slice(at + 1);
        break;
      case 3: {
        // repeat a range
        const piece = text.slice(at, at + random.int(40));
        text =
          text.slice(0, at) + piece.repeat(1 + random.int(8)) + text.slice(at);
        break;
      }
      case 4: {
        // swap two ranges
        const other = random.int(text.length + 1);
        const [a, b] = at < other ? [at, other] : [other, at];
        text = text.slice(0, a) + text.slice(b) + text.slice(a, b);
        break;
      }
      case 5: // truncate
        text = text.slice(0, at);
        break;
      default: {
        // duplicate a line
        const lines = text.split("\n");
        const line = random.int(lines.length);
        lines.splice(line, 0, lines[line] ?? "");
        text = lines.join("\n");
      }
    }
  }
  return text;
}

/** More cases for a longer hunt: `UI_FUZZ_SCALE=20 pnpm --filter pim-web test ui-lang.fuzz`. */
const SCALE = Number(process.env.UI_FUZZ_SCALE ?? 1);

/** Slowest a single case may be, ms. Cases here take a few ms; this is a ceiling that only a runaway meets. */
const CASE_LIMIT_MS = 1500;

/** What a source, drawn and driven, must satisfy. */
function exercise(random: Random, source: string, label: string) {
  const started = performance.now();
  try {
    for (const partial of [false, true]) {
      const program = compile(source, { partial });
      expect(Array.isArray(program.diagnostics), label).toBe(true);
      expect(typeof program.valid, label).toBe("boolean");
      expect(typeof program.fallbackMarkdown, label).toBe("string");
      // A program is plain JSON.
      JSON.stringify(program);
      const keys = [
        ...program.stateKeys,
        ...Object.keys(program.forms),
        "__proto__",
        "constructor",
        "prototype",
        "b0",
        "nope",
      ];
      const events: (UiEvent | null)[] = [null];
      for (let index = 0; index < 4; index++) {
        const key = random.pick(keys);
        events.push(
          random.pick<UiEvent>([
            {
              type: "change",
              key,
              value: random.pick<string | number | boolean>([
                "",
                "5",
                "abc",
                "-1e9",
                true,
                7,
                "x".repeat(3000),
              ]),
            },
            { type: "submit", form: key },
            { type: "reveal", form: key },
            { type: "click", key },
          ]),
        );
      }
      let state = initialState(program);
      for (const event of events) {
        const result = evaluate(program, state, event);
        expect(
          result.error === null || typeof result.error === "string",
          label,
        ).toBe(true);
        if (result.error === null) state = result.state;
        JSON.stringify(result.tree);
      }
    }
  } catch (error) {
    throw new Error(
      `${label}: ${(error as Error).message}\nsource: ${JSON.stringify(source.slice(0, 300))}`,
      { cause: error },
    );
  }
  const took = performance.now() - started;
  if (took > CASE_LIMIT_MS) {
    throw new Error(
      `${label} took ${Math.round(took)} ms (limit ${CASE_LIMIT_MS})\nsource: ${JSON.stringify(source.slice(0, 300))}`,
    );
  }
}

describe("fuzzing the ui language", () => {
  it("survives a valid program cut off at every character", () => {
    const random = seeded(1);
    for (const [name, source] of Object.entries(CORPUS)) {
      expect(compile(source).valid, `${name} is valid`).toBe(true);
      for (let end = 0; end <= source.length; end++) {
        exercise(random, source.slice(0, end), `${name} cut at ${end}`);
        // And from the other end: what is left when the start is missing.
        if (end % 7 === 0)
          exercise(random, source.slice(end), `${name} from ${end}`);
      }
    }
  });

  it("survives a valid program mutated at random", () => {
    for (const [name, source] of Object.entries(CORPUS)) {
      for (let seed = 1; seed <= 400 * SCALE; seed++) {
        const random = seeded(seed * 7919);
        exercise(random, mutate(random, source), `${name} seed ${seed}`);
      }
    }
  }, 60_000 * SCALE);

  it("survives random text built from the language's own pieces", () => {
    for (let seed = 1; seed <= 300 * SCALE; seed++) {
      const random = seeded(seed * 104729);
      const length = 1 + random.int(60);
      const source = Array.from({ length }, () => random.pick(TOKENS)).join(
        random.pick(["", " ", "\n"]),
      );
      exercise(random, source, `tokens seed ${seed}`);
    }
  }, 60_000 * SCALE);

  it("is deterministic: the same source compiles and draws the same", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const random = seeded(seed * 31);
      const source = mutate(random, random.pick(Object.values(CORPUS)));
      const a = compile(source);
      const b = compile(source);
      expect(b, `seed ${seed}`).toEqual(a);
      expect(evaluate(b, initialState(b), null), `seed ${seed}`).toEqual(
        evaluate(a, initialState(a), null),
      );
    }
  });
});

/** A random arithmetic expression, as source and as the number it works out to. */
function arithmetic(
  random: Random,
  depth: number,
): { source: string; value: number } {
  if (depth === 0 || random.int(4) === 0) {
    const n = random.int(10);
    return { source: String(n), value: n };
  }
  const left = arithmetic(random, depth - 1);
  const right = arithmetic(random, depth - 1);
  switch (random.int(4)) {
    case 0:
      return {
        source: `(${left.source} + ${right.source})`,
        value: left.value + right.value,
      };
    case 1:
      return {
        source: `(${left.source} - ${right.source})`,
        value: left.value - right.value,
      };
    case 2:
      return {
        source: `(${left.source} * ${right.source})`,
        value: left.value * right.value,
      };
    default:
      return { source: `-${left.source}`, value: -left.value };
  }
}

describe("the interpreter against independent arithmetic", () => {
  it("works out random parenthesized expressions as arithmetic does", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const random = seeded(seed * 13);
      const { source, value } = arithmetic(random, 3);
      const program = compile(`{${source}}`);
      const result = evaluate(program, initialState(program), null);
      expect(result.error, source).toBeNull();
      // A zero is "0" however it was reached.
      expect(program.fallbackMarkdown, source).toBe(
        String(value === 0 ? 0 : value),
      );
    }
  });

  it("gives * more weight than + and -, and goes left to right", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = seeded(seed * 17);
      const terms = Array.from({ length: 2 + random.int(4) }, () =>
        random.int(10),
      );
      const ops = terms.slice(1).map(() => random.pick(["+", "-", "*"]));
      const source = terms
        .map((term, index) =>
          index === 0 ? `${term}` : `${ops[index - 1]} ${term}`,
        )
        .join(" ");
      // The oracle: products first, then the sums and differences left to right.
      const products: number[] = [terms[0] as number];
      const signs: string[] = [];
      ops.forEach((op, index) => {
        const term = terms[index + 1] as number;
        if (op === "*") products[products.length - 1] = (products[products.length - 1] as number) * term;
        else {
          signs.push(op);
          products.push(term);
        }
      });
      const expected = products.reduce(
        (total, product, index) =>
          index === 0
            ? product
            : signs[index - 1] === "+"
              ? total + product
              : total - product,
        0,
      );
      const program = compile(`{${source}}`);
      expect(program.fallbackMarkdown, source).toBe(
        String(expected === 0 ? 0 : expected),
      );
    }
  });
});

describe("sources shaped to be slow or deep", () => {
  const shapes: Record<string, string> = {
    "nested elements": "<box>".repeat(12000),
    "nested elements, closed": `${"<box>".repeat(8000)}x${"</box>".repeat(8000)}`,
    "nested ifs": "{#if 1}".repeat(9000),
    "nested each": "{#each [1] as x}".repeat(4000),
    "nested parentheses": `{${"(".repeat(30000)}1${")".repeat(30000)}}`,
    "nested lists": `{${"[".repeat(30000)}${"]".repeat(30000)}}`,
    "nested objects": `{${"{a:".repeat(10000)}1${"}".repeat(10000)}}`,
    "nested calls": `{${"abs(".repeat(10000)}1${")".repeat(10000)}}`,
    "nested ternaries": `{${"1 ? ".repeat(8000)}1${" : 1".repeat(8000)}}`,
    "a long chain of nots": `{${"!".repeat(30000)}1}`,
    "a long chain of minuses": `{${"-".repeat(30000)}1}`,
    "a long chain of members": `{a${".length".repeat(8000)}}`,
    "a long sum": `{${"1+".repeat(20000)}1}`,
    "many broken tags": "<box ".repeat(10000),
    "many broken braces": "{".repeat(30000),
    "many broken statements": "{@state a = \n".repeat(4000),
    "many diagnostics": "</x>".repeat(10000),
    "unterminated string": `{"${"a".repeat(30000)}`,
    "a very long line": "a".repeat(MAX_SOURCE_BYTES),
    "many lines": "\n".repeat(MAX_SOURCE_BYTES),
    "many strings": `{[${Array(5000).fill('"x"').join(",")}]}`,
  };

  for (const [name, source] of Object.entries(shapes)) {
    it(`handles ${name}`, () => {
      exercise(seeded(5), source.slice(0, MAX_SOURCE_BYTES), name);
    });
  }

  it("stays quick when the evaluation fans out", () => {
    // Each level multiplies what the one above did: the step budget must end it.
    const source = [
      "{@let a = [1,2,3,4,5,6,7,8,9,10]}",
      "{#each a as i}{#each a as j}{#each a as k}{#each a as l}{#each a as m}{i}{/each}{/each}{/each}{/each}{/each}",
    ].join("\n");
    exercise(seeded(6), source, "fan out");
    const program = compile(source);
    expect(evaluate(program, initialState(program), null).error).toContain(
      "steps",
    );
  });

  it("stays quick when a string doubles", () => {
    const double = (index: number) =>
      `{@let s${index} = ${index === 0 ? "s" : `s${index - 1}`} + ${index === 0 ? "s" : `s${index - 1}`}}`;
    const source = [
      '{@let s = "abcdefgh"}',
      ...Array.from({ length: 24 }, (_, index) => double(index)),
      "{len(s23)}",
    ].join("\n");
    exercise(seeded(7), source, "doubling");
  });
});
