/** Skills that come with Pim, which every agent can load with `read_skill` and that are listed in its prompt beside the person's own. A skill of the person's with the same name takes their place. */
export type BuiltinSkill = { name: string; description: string; instructions: string };

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
	{
		name: "notes",
		description: "How to write in the person's notes, which they edit with you live: when to start one, how to change one without losing their typing, and how to draw diagrams and pictures in one.",
		instructions: `# Notes

Notes are the person's documents in Pim: plans, lists, drafts, research, meeting notes. They're Markdown, and the person may have a note open and be typing in it while you work: they see your changes as you make them, and you see theirs the next time you read it.

## When to write a note
- Write a note for anything the person will come back to or keep working on: a plan, a list, a draft, a summary of what you found. Answer in the chat for what they only need to read once.
- Before starting one, look for a note on the same topic with note_list, and add to it rather than making another.
- note_create and note_edit show the note in the chat as a card the person opens beside the chat; that card is the only way they see a note, and you have no panel to open. To show a note again, such as one from another chat or one they ask you to open, use note_show. Say in a sentence what you wrote or changed; don't repeat the note's text in the chat.

## Changing a note
- Read it with note_read right before you change it: the person may have changed it since you last looked.
- Change it with edits: find-and-replace pairs, each find copied exactly from what you read and long enough to appear once. They land where the text is now, so what the person typed elsewhere stays; if one no longer matches, nothing is changed and you read the note again.
- Add to the end with append, and rename with title.
- Give content, the whole text, only when the person asked you to rewrite the note, with base_version the version you read. It's refused if the note changed since, so their typing is never lost unseen.
- Keep the person's words: don't reformat, reorder or tidy what they wrote unless they ask.

## Writing in one
- Use Markdown: headings, lists, task lists (\`- [ ]\`), tables, links, code. Images and raw HTML aren't shown. The note's title is its own; the text needn't repeat it.
- Draw a diagram with a \`\`\`mermaid block (flowchart, sequenceDiagram, gantt, timeline, mindmap and so on), without another fence around it.
- Draw a picture, a logo or a chart with an \`\`\`svg block: one <svg> element with a viewBox, inline and self-contained, since it loads nothing from elsewhere.
- The person sees blocks drawn when they preview the note, and as source while they write.
- Don't put passwords, codes or personal details in a note unless the person asks.`,
	},
];

export const builtinSkill = (name: string): BuiltinSkill | undefined => BUILTIN_SKILLS.find((s) => s.name === name);
