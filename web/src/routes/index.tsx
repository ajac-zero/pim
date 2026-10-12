import { createFileRoute, redirect } from "@tanstack/react-router";
import { personasQuery } from "~/lib/queries";

/** Opens the default Pim's dashboard. */
export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    const personas = await context.queryClient.fetchQuery(personasQuery());
    const pim = personas.find((persona) => persona.default) ?? personas[0];
    if (pim === undefined) throw redirect({ to: "/new" });
    throw redirect({ to: "/pims/$pimId", params: { pimId: pim.id } });
  },
});
