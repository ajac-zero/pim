import { createFileRoute } from "@tanstack/react-router";
import { CodingThreadPage } from "~/components/coding";

export const Route = createFileRoute("/coding/$threadId")({
  component: CodingThreadRoute,
});

function CodingThreadRoute() {
  const { threadId } = Route.useParams();
  return <CodingThreadPage key={threadId} id={threadId} />;
}
