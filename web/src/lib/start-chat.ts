import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { pim, type UserContent } from "~/lib/pim-api";
import { pimClient } from "~/lib/pim-client";
import { sessionsQuery } from "~/lib/queries";
import { openTab } from "~/lib/tabs";

/**
 * Starts a chat with an agent (the majordomo when `agent` is undefined)
 * with its first message: the chat is made only when there is something to
 * send, then sent to and opened together. `sent` is that message from the moment
 * it is sent, so the page can show it at once rather than after Pim has made
 * the chat.
 */
export function useStartChat(agent: string | undefined) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [sent, setSent] = useState<UserContent | null>(null);

  const start = async (content: UserContent) => {
    setSent(content);
    try {
      const session = await pim.createSession(agent ? { agent } : {});
      // The chat's page finds the chat in the list at once, rather than
      // fetching the list, which sending's own refresh of it would cancel.
      queryClient.setQueryData(
        sessionsQuery().queryKey,
        (sessions) => sessions && [session, ...sessions],
      );
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      openTab(session.id);
      pimClient.open(session.id);
      await Promise.all([
        pimClient.send(content),
        navigate({
          to: "/chat/$sessionId",
          params: { sessionId: session.id },
        }),
      ]);
    } catch (error) {
      toast.error((error as Error).message);
      setSent(null);
    }
  };

  return { start, sent };
}
