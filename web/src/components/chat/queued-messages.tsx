import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { CornerDownRight, ImageIcon, Pencil, X } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { ApiError, pim } from "~/lib/pim-api";
import type { QueuedMessage } from "~/lib/pim-view";

type Change =
  | { kind: "steer"; id: number }
  | { kind: "edit"; id: number; text: string }
  | { kind: "cancel"; id: number };

/**
 * The person's messages waiting for the agent to finish what it's doing, as
 * a small tray on top of the composer. Each can be steered into the running
 * work after the agent's current step, edited, or taken back, until the
 * agent reads it; the list follows the chat's stream, so a message leaves it
 * once the agent has it.
 */
export function QueuedMessages({
  sessionId,
  queue,
}: {
  sessionId: string;
  queue: readonly QueuedMessage[];
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(
    null,
  );
  const change = useMutation({
    mutationFn: (change: Change) =>
      change.kind === "steer"
        ? pim.steerQueued(sessionId, change.id)
        : change.kind === "edit"
          ? pim.editQueued(sessionId, change.id, change.text)
          : pim.cancelQueued(sessionId, change.id),
    onSuccess: (_, change) => {
      if (change.kind === "edit") setEditing(null);
    },
    onError: (error: Error, change) => {
      if (error instanceof ApiError && error.status === 409) {
        toast(t("queuedAlreadySent"));
        if (change.kind === "edit") setEditing(null);
      } else toast.error(error.message);
    },
  });
  if (queue.length === 0) return null;
  const busy = (id: number) => change.isPending && change.variables.id === id;
  const save = () => {
    if (editing && editing.text.trim() !== "")
      change.mutate({ kind: "edit", id: editing.id, text: editing.text });
  };

  return (
    <ul
      aria-label={t("queuedMessages")}
      className="mx-3 flex max-h-48 animate-in flex-col overflow-y-auto rounded-t-[14px] border border-b-0 bg-muted/50 p-1 duration-150 fade-in"
    >
      {queue.map((message) =>
        editing?.id === message.id ? (
          <li key={message.id} className="flex flex-col gap-1.5 p-1">
            <textarea
              // biome-ignore lint/a11y/noAutofocus: the person just asked to edit it.
              autoFocus
              aria-label={t("editQueued")}
              value={editing.text}
              onChange={(event) =>
                setEditing({ id: message.id, text: event.target.value })
              }
              onFocus={(event) =>
                event.currentTarget.setSelectionRange(
                  event.currentTarget.value.length,
                  event.currentTarget.value.length,
                )
              }
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(null);
                } else if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  save();
                }
              }}
              rows={1}
              className="field-sizing-content max-h-32 w-full resize-none rounded-[10px] border bg-background px-2.5 py-1.5 text-[15px] outline-none focus-visible:border-ring/60"
            />
            <div className="flex justify-end gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setEditing(null)}
              >
                {t("cancel")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="xs"
                disabled={editing.text.trim() === "" || busy(message.id)}
                onClick={save}
              >
                {t("save")}
              </Button>
            </div>
          </li>
        ) : (
          <li
            key={message.id}
            className="flex min-h-7 items-center gap-2 rounded-[10px] pr-1 pl-2.5 text-[13px]"
          >
            <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate" title={message.text}>
              {message.text}
            </span>
            {message.images > 0 && (
              <span
                title={t("queuedImages", { count: message.images })}
                className="flex shrink-0 items-center gap-0.5 text-muted-foreground"
              >
                <ImageIcon className="size-3.5" />
                {message.images}
              </span>
            )}
            {message.steer ? (
              <span className="shrink-0 px-2 text-muted-foreground">
                {t("steering")}
              </span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                title={t("steerQueuedHint")}
                disabled={busy(message.id)}
                onClick={() => change.mutate({ kind: "steer", id: message.id })}
                className="text-[13px]"
              >
                {t("steerQueued")}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("editQueued")}
              title={t("editQueued")}
              disabled={busy(message.id)}
              onClick={() => setEditing({ id: message.id, text: message.text })}
            >
              <Pencil />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("cancelQueued")}
              title={t("cancelQueued")}
              disabled={busy(message.id)}
              onClick={() => change.mutate({ kind: "cancel", id: message.id })}
            >
              <X />
            </Button>
          </li>
        ),
      )}
    </ul>
  );
}
