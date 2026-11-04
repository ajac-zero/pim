import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AgentIcon } from "~/components/agent-icon";
import { useNewChat } from "~/components/app-sidebar";
import { ChatTabs } from "~/components/chat/tabs";
import { useI18n } from "~/components/i18n";
import { SquarePen } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { agentsQuery } from "~/lib/queries";
import { useTabs } from "~/lib/tabs";

export const Route = createFileRoute("/")({ component: Home });

/** The app's home, with no chat open: the open chats' tabs, none selected, and New chat. */
function Home() {
  const { t } = useI18n();
  const { data: agents } = useQuery(agentsQuery());
  const majordomo = agents?.find((agent) => agent.majordomo);
  const shelf = useTabs().length > 0;
  const newChat = useNewChat();
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      {shelf && (
        <header className="hidden h-13 shrink-0 bg-sidebar pr-4 md:flex">
          <ChatTabs activeId="" />
        </header>
      )}
      <div className="flex flex-1 flex-col items-center justify-center gap-5 p-6">
        {majordomo && (
          <AgentIcon agent={majordomo} tile className="size-12 rounded-xl" />
        )}
        <Button onClick={newChat} className="rounded-full">
          <SquarePen /> {t("newChat")}
        </Button>
      </div>
    </main>
  );
}
