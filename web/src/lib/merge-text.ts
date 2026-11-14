import { diff3Merge } from "node-diff3";

/*
 * Three-way merge of a file's text by lines: what the person has in the
 * editor (`mine`), the version on disk their edits started from (`base`) and
 * the version on disk now (`theirs`). Changes to different places merge;
 * changes to the same lines don't, and the merge says so.
 */

export type Merged =
  /** Every change fit: the text with both sides' changes. */
  | { clean: true; text: string }
  /** Some lines changed on both sides: `text` has them between conflict markers. */
  | { clean: false; text: string };

export function mergeText(mine: string, base: string, theirs: string): Merged {
  const regions = diff3Merge(
    mine.split("\n"),
    base.split("\n"),
    theirs.split("\n"),
    { excludeFalseConflicts: true },
  );
  let clean = true;
  const lines: string[] = [];
  for (const region of regions) {
    if (region.ok) {
      lines.push(...region.ok);
      continue;
    }
    clean = false;
    lines.push(
      "<<<<<<< mine",
      ...region.conflict.a,
      "||||||| earlier",
      ...region.conflict.o,
      "=======",
      ...region.conflict.b,
      ">>>>>>> on disk",
    );
  }
  return { clean, text: lines.join("\n") };
}
