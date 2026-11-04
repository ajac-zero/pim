import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { pim, type UserContent } from "~/lib/pim-api";
import { pimClient } from "~/lib/pim-client";
import { sessionsQuery } from "~/lib/queries";

/**
 * Starts a chat with an agent (the majordomo when `agent` is undefined)
 * with its first message: the chat is made only when there is something to
 * send, then sent to and opened together, in place of the page that started
 * it, so Back skips New chat. `starting` is true from the moment the message
 * is sent until the chat opens, or fails to.
 */
export function useStartChat(agent: string | undefined) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);

  const start = async (content: UserContent) => {
    setStarting(true);
    try {
      const session = await pim.createSession(agent ? { agent } : {});
      // The chat's page finds the chat in the list at once, rather than
      // fetching the list, which sending's own refresh of it would cancel.
      queryClient.setQueryData(
        sessionsQuery().queryKey,
        (sessions) => sessions && [session, ...sessions],
      );
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      pimClient.open(session.id);
      await Promise.all([
        pimClient.send(content),
        navigate({
          to: "/chat/$sessionId",
          params: { sessionId: session.id },
          replace: true,
        }),
      ]);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setStarting(false);
    }
  };

  return { start, starting };
}
