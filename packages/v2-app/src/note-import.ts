import * as Y from "yjs";

/** The Yjs text a note's markdown lives in, as the Canvas reads and writes it (and as the legacy Worker's notes did). */
const TEXT = "markdown";

/** A Yjs update that makes a document of this text: the first update of an imported note. */
export function noteUpdateFromText(text: string): Uint8Array {
	const doc = new Y.Doc();
	doc.getText(TEXT).insert(0, text);
	return Y.encodeStateAsUpdate(doc);
}

/** The state a legacy note's saved Yjs updates add up to, and the text in it; a note edited live and not yet saved as a version keeps its words in these, not in its last version. */
export function mergeNoteUpdates(updates: readonly Uint8Array[]): { update: Uint8Array; text: string } {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, Y.mergeUpdates([...updates]));
	return { update: Y.encodeStateAsUpdate(doc), text: doc.getText(TEXT).toString() };
}
