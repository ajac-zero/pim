import { expect, it } from "vitest";
import { mergeText } from "~/lib/merge-text";

it("merges changes to different lines of both sides", () => {
  expect(mergeText("A\nb\nc\nd\ne", "a\nb\nc\nd\ne", "a\nb\nc\nd\nE")).toEqual({
    clean: true,
    text: "A\nb\nc\nd\nE",
  });
});

it("takes an identical change on both sides once", () => {
  expect(mergeText("a\nX\nc", "a\nb\nc", "a\nX\nc")).toEqual({
    clean: true,
    text: "a\nX\nc",
  });
});

it("marks lines both sides changed differently, keeping both and the original", () => {
  expect(mergeText("a\nmine\nc", "a\nb\nc", "a\ntheirs\nc")).toEqual({
    clean: false,
    text: "a\n<<<<<<< mine\nmine\n||||||| earlier\nb\n=======\ntheirs\n>>>>>>> on disk\nc",
  });
});

it("keeps a line one side deleted and the other left alone deleted", () => {
  expect(mergeText("a\nb\nc", "a\nb\nc", "a\nc")).toEqual({
    clean: true,
    text: "a\nc",
  });
});
