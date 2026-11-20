import { describe, expect, it } from "vitest";
import { terminalRuns } from "~/components/chat/terminal-dialog";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe("terminalRuns", () => {
  it("colors what SGR sequences color, until a reset", () => {
    expect(
      terminalRuns(`${ESC}[1;32m✓${ESC}[0m ok ${ESC}[91mfail${ESC}[39m!`),
    ).toEqual([
      { text: "✓", bold: true, color: "#a6da95" },
      { text: " ok " },
      { text: "fail", color: "#ff8b92" },
      { text: "!", color: undefined },
    ]);
  });

  it("drops other escapes, keeps a line as its last carriage return left it, and skips 256-color numbers", () => {
    const output = `${ESC}]0;title${BEL}${ESC}[2Kloading 10%\rloading 100%\r\nnext ${ESC}[38;5;31mblue${ESC}[m`;
    expect(terminalRuns(output)).toEqual([
      { text: "loading 100%\nnext " },
      { text: "blue" },
    ]);
  });
});
