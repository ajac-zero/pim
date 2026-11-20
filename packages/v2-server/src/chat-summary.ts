/**
 * What a sidebar row says of a chat beyond what the runtime knows: when it began and was last answered, whether it was archived by hand, and the
 * agent and model it answers as. The application's table holds them; the Gate adds them to the sidebar snapshot (`gate-extras.ts`) and the chat feed
 * (`chat-feed-source.ts`) puts them in the projection, so a row read from the snapshot and a row heard live say the same.
 */

/** The columns of a chat the summary is made of, as the snapshot's query and migration 0711's feed function both return them. */
export type ChatColumns = {
	created_at: Date;
	response_at: Date | null;
	archived: boolean;
	agent_id: string | null;
	agent_name: string | null;
	model: { provider: string; id: string } | null;
};

/** A chat's own model as the app's `Session.model`; the app finds the rest of it (name, images) among the choices. */
const chosenModel = (m: { provider: string; id: string }) => ({ model: { provider: m.provider, id: m.id, name: m.id, images: false }, override: true });

/** A key a chat no longer has is `null`, not absent: the projection merges summaries, and a merge can't take a key away. */
export function chatSummary(r: ChatColumns) {
	return {
		createdAt: new Date(r.created_at).getTime(),
		responseAt: r.response_at ? new Date(r.response_at).getTime() : null,
		archived: r.archived,
		agent: r.agent_id ? { id: r.agent_id, name: r.agent_name } : null,
		model: r.model ? chosenModel(r.model) : null,
	};
}
