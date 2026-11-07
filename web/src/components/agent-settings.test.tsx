import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AgentSkills } from "~/components/agent-settings";
import { ContactMap } from "~/components/contact-map";
import type { Agent } from "~/lib/pim-api";
import { agentSkillsPermissionQuery, agentsQuery } from "~/lib/queries";

const rowan = { id: "p_rowan", name: "Rowan", majordomo: false } as Agent;

/** The section as the page draws it first, from what the query has; a failed query isn't fetched again. */
function render(client: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <AgentSkills agent={rowan} />
    </QueryClientProvider>,
  );
}

it("shows an agent's switch for skills without promising to ask every time", () => {
  const client = new QueryClient();
  client.setQueryData(agentSkillsPermissionQuery(rowan.id).queryKey, {
    app: null,
    appName: null,
    tool: "write_skill",
    name: "write_skill",
    description: null,
    readOnly: false,
    destructive: false,
    permission: "off",
    default: "on",
    chosen: "off",
    changed: false,
    choices: ["off", "on"],
  });
  const html = render(client);
  expect(html).toContain('aria-checked="false"');
  expect(html).toContain("follows write_skill in Tool permissions");
  expect(html).not.toContain("each time");
});

it("says why the switch isn't shown when it can't be loaded", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  await client.prefetchQuery({
    queryKey: agentSkillsPermissionQuery(rowan.id).queryKey,
    queryFn: () => Promise.reject(new Error("No agent p_rowan")),
  });
  const html = render(client);
  expect(html).toContain('role="alert"');
  expect(html).toContain(
    "Couldn&#x27;t load whether Rowan can write skills: No agent p_rowan",
  );
  expect(html).not.toContain('role="switch"');
});

it("draws every contact and brings out the chosen agent's", () => {
  const look = { icon: null, symbol: null, color: null, contacts: [] };
  const agents = [
    { ...look, id: "p_major", name: "Major", majordomo: true },
    { ...look, id: "p_rowan", name: "Rowan", contacts: ["p_kit"] },
    { ...look, id: "p_kit", name: "Kit", contacts: ["p_rowan", "p_ash"] },
    { ...look, id: "p_ash", name: "Ash" },
  ] as unknown as Agent[];
  const client = new QueryClient();
  client.setQueryData(agentsQuery().queryKey, agents);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ContactMap selected="p_rowan" onSelect={() => {}} />
    </QueryClientProvider>,
  );
  // Every contact has a line, not only the chosen agent's.
  expect(html.match(/<title>/g)).toHaveLength(3);
  expect(html).toContain("Kit hands tasks to Ash.");
  expect(html).toContain('aria-label="Kit. Hands tasks to Rowan, Ash"');
  // Rowan hands tasks to Kit, but not to Ash, though Kit does.
  expect(html).toContain('aria-label="Stop Rowan handing tasks to Kit"');
  expect(html).toContain('aria-label="Have Rowan hand tasks to Ash"');
  // Only Ash, with no line to or from Rowan, is greyed out.
  expect(html.match(/opacity-40/g)).toHaveLength(1);
});
