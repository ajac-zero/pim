import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
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

/**
 * Forks a chat into a new one and opens it: `fork` through one of the
 * agent's messages, keeping this chat as it is, or `edit` one of the
 * person's, which goes again changed in a fork up to it. Either way this
 * chat stays as it was, in the list, and Back returns to it.
 */
export function useForkChat(session: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Stable, so the messages that take these don't draw again with every change to the chat.
  return useMemo(() => {
    const open = async (
      from: { at: string } | { before: string },
      content?: UserContent,
    ) => {
      try {
        const forked = await pim.forkSession(session, from);
        queryClient.setQueryData(
          sessionsQuery().queryKey,
          (sessions) => sessions && [forked, ...sessions],
        );
        pimClient.open(forked.id);
        await Promise.all([
          content !== undefined && pimClient.send(content),
          navigate({
            to: "/chat/$sessionId",
            params: { sessionId: forked.id },
          }),
        ]);
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      } catch (error) {
        toast.error((error as Error).message);
      }
    };

    return {
      fork: (message: string) => open({ at: message }),
      edit: (message: string, content: UserContent) =>
        open({ before: message }, content),
    };
  }, [session, queryClient, navigate]);
}

/**
 * The search that opens New chat over the page: with `agent`, a chat with
 * that one rather than the open chat's agent or the majordomo, and with
 * `prompt`, a message to start from.
 */
export const newChatSearch =
  (agent?: string, prompt?: string) =>
  <T extends object>(prev: T) => ({
    ...prev,
    dialog: "new-chat" as const,
    ...(agent && { agent }),
    ...(prompt && { prompt }),
  });
