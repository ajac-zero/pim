import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { pim } from "~/lib/pim-api";
import { pimClient } from "~/lib/pim-client";

/**
 * Starts a chat with a Pim (the default one when `persona` is undefined)
 * with its first message: the chat is made only when there is something to
 * send, then opened, then sent to.
 */
export function useStartChat(persona: string | undefined) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);

  const start = async (text: string) => {
    setStarting(true);
    try {
      const session = await pim.createSession(persona ? { persona } : {});
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      pimClient.open(session.id);
      await navigate({
        to: "/chat/$sessionId",
        params: { sessionId: session.id },
      });
      await pimClient.send(text);
    } catch (error) {
      toast.error((error as Error).message);
      setStarting(false);
    }
  };

  return { start, starting };
}
