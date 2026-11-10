import { createFileRoute } from "@tanstack/react-router";
import { WithChatTabs } from "~/components/chat/tabs";
import { CodingThreadPage } from "~/components/coding";

export const Route = createFileRoute("/coding/$threadId")({
  component: CodingThreadRoute,
});

function CodingThreadRoute() {
  const { threadId } = Route.useParams();
  return (
    <WithChatTabs>
      <CodingThreadPage key={threadId} id={threadId} />
    </WithChatTabs>
  );
}
