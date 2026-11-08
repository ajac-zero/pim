import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Dialog } from "radix-ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ARTIFACT_KIND_NAMES, ArtifactIcon } from "~/components/artifact-icon";
import { useI18n } from "~/components/i18n";
import { SquarePen, X } from "~/components/icons";
import { useNotesOn } from "~/components/sidebar-panels";
import { Button } from "~/components/ui/button";
import { thumbnail } from "~/lib/artifact-thumbnails";
import {
  type Artifact,
  type ArtifactFrom,
  type ArtifactKind,
  artifactFrameUrl,
  pim,
  type SharedArtifact,
} from "~/lib/pim-api";
import { artifactsQuery, sharedArtifactsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/** The tile of each kind of app, in the colors agents' icons use. */
const KIND_TILES: Record<ArtifactKind, string> = {
  html: "bg-agent-orange/15 text-agent-orange",
  markdown: "bg-agent-blue/15 text-agent-blue",
  svg: "bg-agent-pink/15 text-agent-pink",
  mermaid: "bg-agent-green/15 text-agent-green",
  jsx: "bg-agent-teal/15 text-agent-teal",
  hosted: "bg-agent-violet/15 text-agent-violet",
};

const CARD_CLASS =
  "flex flex-col gap-3 rounded-2xl bg-muted/50 p-4 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The kinds an app runs in a frame, which can show themselves on their card. */
const FRAMED_KINDS: readonly ArtifactKind[] = ["html", "svg", "mermaid", "jsx"];
/** How long a pointer rests on a card before its app starts, so moving across the grid starts none. */
const HOVER_MS = 300;
/** The size of the window an app is laid out in on its card, which the frame then shrinks to the card. */
const WINDOW = { width: 1024, height: 640 };

/**
 * What a card needs to show its app: whether the pointer has rested on it
 * or it has the keyboard's focus. A touch screen has no hovering, so a tap
 * only opens the app.
 */
function Hover({
  children,
}: {
  children: (hover: {
    active: boolean;
    handlers: {
      onPointerEnter: (event: React.PointerEvent) => void;
      onPointerLeave: () => void;
      onFocus: () => void;
      onBlur: () => void;
    };
  }) => ReactNode;
}) {
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const stop = () => {
    clearTimeout(timer.current);
    setActive(false);
  };
  return children({
    active,
    handlers: {
      onPointerEnter: (event) => {
        if (event.pointerType === "touch") return;
        timer.current = setTimeout(() => setActive(true), HOVER_MS);
      },
      onPointerLeave: stop,
      onFocus: () => setActive(true),
      onBlur: stop,
    },
  });
}

/**
 * An app's wide tile, in its kind's color, with a freeze frame of the app
 * over it once there is one: drawn when the card first comes into view, once
 * per version, and kept on the device (see `~/lib/artifact-thumbnails`).
 * A freeze frame is a drawing of the page, so it can look a little off; while
 * the card is hovered or focused, the app itself runs over it instead,
 * as in its own frame but with no bridge, so it can't reach Pim or its
 * model, scaled down to the card. It stops when the pointer leaves.
 */
function Preview({
  id,
  title,
  version,
  kind,
  from,
  active,
}: {
  id: string;
  title: string;
  version: number;
  kind: ArtifactKind;
  from?: ArtifactFrom;
  active: boolean;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [scale, setScale] = useState(0.3);
  const [loaded, setLoaded] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const host = from && "host" in from ? from.host : undefined;
  const framed = FRAMED_KINDS.includes(kind);
  const running = active && framed;
  useEffect(() => {
    const node = box.current;
    if (!node || !framed) return;
    let current = true;
    const seen = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      seen.disconnect();
      void thumbnail(id, version, host ? { host } : undefined).then(
        (picture) => current && setImage(picture),
      );
    });
    seen.observe(node);
    return () => {
      current = false;
      seen.disconnect();
    };
  }, [id, version, framed, host]);
  useEffect(() => {
    if (!running) setLoaded(false);
    else if (box.current) setScale(box.current.offsetWidth / WINDOW.width);
  }, [running]);
  return (
    <span
      ref={box}
      className={`relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl ${KIND_TILES[kind]}`}
    >
      <ArtifactIcon kind={kind} className="size-8" />
      {image && (
        <img
          src={image}
          alt=""
          className="absolute inset-0 size-full animate-in object-cover object-top fade-in-0"
        />
      )}
      {running && (
        <iframe
          title={title}
          aria-hidden="true"
          tabIndex={-1}
          src={artifactFrameUrl(id, version, from)}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          style={{
            width: WINDOW.width,
            height: WINDOW.height,
            transform: `scale(${scale})`,
          }}
          className={cn(
            "pointer-events-none absolute top-0 left-0 origin-top-left border-0 bg-white transition-opacity duration-200",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
      )}
    </span>
  );
}

/** What a card says under its picture: the app's title, and its kind or who shared it, with a date. */
function CardText({ title, meta }: { title: string; meta: string }) {
  return (
    <span className="min-w-0">
      <span className="block truncate font-medium text-[15px]">{title}</span>
      <span className="block truncate text-muted-foreground text-xs">
        {meta}
      </span>
    </span>
  );
}

const GRID = "grid grid-cols-2 gap-3 sm:grid-cols-3";

function SectionHeading({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mt-6 mb-3 flex min-h-8 items-center justify-between gap-2 first:mt-0">
      <h3 className="font-medium text-muted-foreground text-xs">{children}</h3>
      {action}
    </div>
  );
}

/**
 * Your apps, the documents and pages your agents made, as cards over
 * whatever page is open, most recently changed first; with Notes on, your
 * notes, which you write in with your agents, are a section of their own
 * with a button that starts one; then the ones shared with you. Choosing a
 * card closes the dialog and opens it.
 */
export function ArtifactsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, formatDate } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const notesOn = useNotesOn();
  const { data } = useQuery(artifactsQuery());
  const { data: shared } = useQuery(sharedArtifactsQuery());
  const close = () => onOpenChange(false);
  const createNote = useMutation({
    mutationFn: () => pim.createNote(t("untitledNote")),
    onSuccess: async (note) => {
      await queryClient.invalidateQueries({ queryKey: ["artifacts"] });
      close();
      await navigate({
        to: "/artifacts/$artifactId",
        params: { artifactId: note.id },
        search: { v: note.version },
      });
    },
    onError: (error) => toast.error(error.message),
  });
  const isNote = (artifact: { kind: ArtifactKind }) =>
    notesOn && artifact.kind === "markdown";
  const apps = data?.artifacts.filter((artifact) => !isNote(artifact));
  const notes = data?.artifacts.filter(isNote);
  const card = (artifact: Artifact | SharedArtifact) => {
    const host = "host" in artifact ? artifact.host : undefined;
    const date = formatDate(new Date(artifact.updatedAt), {
      month: "short",
      day: "numeric",
    });
    const kind = isNote(artifact)
      ? date
      : `${ARTIFACT_KIND_NAMES[artifact.kind]} · ${date}`;
    return (
      <li key={`${host ?? ""}/${artifact.id}`} className="contents">
        <Hover>
          {({ active, handlers }) => {
            const picture = (
              <>
                <Preview
                  id={artifact.id}
                  title={artifact.title}
                  version={artifact.version}
                  kind={artifact.kind}
                  from={host ? { host } : undefined}
                  active={active}
                />
                <CardText
                  title={artifact.title}
                  meta={
                    host
                      ? `${ARTIFACT_KIND_NAMES[artifact.kind]} · ${t("sharedBy", { host })}`
                      : kind
                  }
                />
              </>
            );
            return host ? (
              <Link
                to="/artifacts/shared/$host/$artifactId"
                params={{ host, artifactId: artifact.id }}
                onClick={close}
                className={CARD_CLASS}
                {...handlers}
              >
                {picture}
              </Link>
            ) : (
              <Link
                to="/artifacts/$artifactId"
                params={{ artifactId: artifact.id }}
                search={{ v: artifact.version }}
                onClick={close}
                className={CARD_CLASS}
                {...handlers}
              >
                {picture}
              </Link>
            );
          }}
        </Hover>
      </li>
    );
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-background p-6 scrollbar-thin data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[min(720px,calc(100dvh-2rem))] sm:w-[calc(100%-2rem)] sm:max-w-3xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:p-8 sm:shadow-xl"
        >
          <Dialog.Title className="mb-6 pr-8 font-semibold text-xl">
            {t("artifacts")}
          </Dialog.Title>
          {apps?.length === 0 && !(notesOn || shared?.length) && (
            <p className="text-muted-foreground text-sm">{t("noArtifacts")}</p>
          )}
          {!!apps?.length && (
            <ul aria-label={t("artifacts")} className={GRID}>
              {apps.map(card)}
            </ul>
          )}
          {notesOn && (
            <>
              <SectionHeading
                action={
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 px-3"
                    disabled={createNote.isPending}
                    onClick={() => createNote.mutate()}
                  >
                    <SquarePen className="size-3.5" />
                    {t("newNote")}
                  </Button>
                }
              >
                {t("notes")}
              </SectionHeading>
              {notes?.length === 0 && (
                <p className="text-muted-foreground text-sm">{t("noNotes")}</p>
              )}
              {!!notes?.length && (
                <ul aria-label={t("notes")} className={GRID}>
                  {notes.map(card)}
                </ul>
              )}
            </>
          )}
          {!!shared?.length && (
            <>
              <SectionHeading>{t("sharedWithYou")}</SectionHeading>
              <ul aria-label={t("sharedWithYou")} className={GRID}>
                {shared.map(card)}
              </ul>
            </>
          )}
          <Dialog.Close className="absolute top-4 right-4 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-4" />
            <span className="sr-only">{t("close")}</span>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
