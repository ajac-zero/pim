import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { pim, type UserContent } from "~/lib/pim-api";
import { pimClient } from "~/lib/pim-client";
import { showTab } from "~/lib/tabs";

/**
 * Starts a chat with an agent (the majordomo when `agent` is undefined)
 * with its first message: the chat is made only when there is something to
 * send, then opened, then sent to.
 */
export function useStartChat(agent: string | undefined) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);

  const start = async (content: UserContent) => {
    setStarting(true);
    try {
      const session = await pim.createSession(agent ? { agent } : {});
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      showTab(session.id, true);
      pimClient.open(session.id);
      await navigate({
        to: "/chat/$sessionId",
        params: { sessionId: session.id },
      });
      await pimClient.send(content);
    } catch (error) {
      toast.error((error as Error).message);
      setStarting(false);
    }
  };

  return { start, starting };
}
