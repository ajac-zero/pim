/**
 * The apps Pim brings, beside the ones people's agents build. Each has its
 * own tools and skill (Notes' are in ./extensions/notes.ts). Every one is on
 * until the admin turns it off for everyone, in Settings → Deployment → Apps;
 * the gallery keeps which are off (./gallery.ts), and each space reads that
 * with the admin's connectors.
 */
export type BuiltinApp = {
	readonly id: string;
	readonly name: string;
	readonly description: string;
};

export const BUILTIN_APPS: readonly BuiltinApp[] = [
	{ id: "notes", name: "Notes", description: "Documents people write with their agents, live, with diagrams and drawings in them." },
];

export const isBuiltinApp = (id: string) => BUILTIN_APPS.some((app) => app.id === id);
