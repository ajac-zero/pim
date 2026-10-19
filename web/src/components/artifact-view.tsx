import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useCanGoBack, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  ARTIFACT_LANGUAGES,
  ArtifactPreview,
  ArtifactPrint,
  formatBytes,
} from "~/components/artifact";
import { useI18n } from "~/components/i18n";
import {
  ArrowLeft,
  ChevronDown,
  Code,
  Download,
  ExternalLink,
  Eye,
  Globe,
  Link2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Printer,
  Trash2,
  Users,
  X,
} from "~/components/icons";
import { Button } from "~/components/ui/button";
import { CodeBlock } from "~/components/ui/code-block";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  ApiError,
  type ArtifactDetail,
  type ArtifactKind,
  artifactDownloadUrl,
  pim,
} from "~/lib/pim-api";
import {
  accountQuery,
  artifactPublicationQuery,
  artifactQuery,
  artifactVersionQuery,
  circlesQuery,
} from "~/lib/queries";
import { cn } from "~/lib/utils";

/**
 * An artifact with its versions: a preview or its source, the person's own
 * edits, sharing, and the rest in a menu. It fills its own page, or the
 * canvas beside the chat it was made in (`onClose`), where the chat's
 * composer takes the place of the button that starts a chat about changes.
 */
export function ArtifactView({
  artifactId,
  version: v,
  onVersion,
  onDeleted,
  onClose,
}: {
  artifactId: string;
  /** The version to show; the latest when unset. */
  version?: number;
  /** Shows another version, such as one just saved or restored. */
  onVersion: (version: number) => void;
  onDeleted: () => void;
  /** Closes the canvas; set only in one. */
  onClose?: () => void;
}) {
  const { t, formatDate, formatNumber } = useI18n();
  const queryClient = useQueryClient();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const [view, setView] = useState<"preview" | "source">("preview");
  // The source being edited, from the latest version; null when not editing.
  const [draft, setDraft] = useState<string | null>(null);
  // The file the source view shows and the editor changes; the main one when unset.
  const [file, setFile] = useState<string>();
  const [printing, setPrinting] = useState(false);
  const donePrinting = useCallback(() => setPrinting(false), []);
  const {
    data: artifact,
    error,
    refetch,
  } = useQuery(artifactQuery(artifactId));
  const version = v ?? artifact?.version;
  const listed = artifact?.history.some((entry) => entry.version === version);
  // A version the cached history lacks may be one made since (the agent works on): ask once, for this artifact
  // and version, before calling it missing. An answer to an earlier artifact or version counts for nothing.
  const wanted = `${artifactId}:${version}`;
  const [askedFor, setAskedFor] = useState<string>();
  useEffect(() => {
    if (listed !== false || askedFor === wanted) return;
    let current = true;
    void refetch().finally(() => {
      if (current) setAskedFor(wanted);
    });
    return () => {
      current = false;
    };
  }, [listed, askedFor, wanted, refetch]);
  const source = useQuery({
    ...artifactVersionQuery(artifactId, version ?? 0, undefined, file),
    enabled: (view === "source" || draft !== null) && listed === true,
  });
  // Another version, or another artifact, isn't the one being edited.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version or artifact ends the edit
  useEffect(() => {
    setDraft(null);
  }, [artifactId, version]);
  // Another artifact starts at its main file.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new artifact shows its main file
  useEffect(() => {
    setFile(undefined);
  }, [artifactId]);

  const save = useMutation({
    mutationFn: ({ base, content }: { base: number; content: string }) =>
      pim.saveArtifact(artifactId, base, content, file),
    onSuccess: async (saved) => {
      setDraft(null);
      if (!saved.changed) {
        toast(t("artifactUnchanged"));
        return;
      }
      toast.success(t("artifactSaved", { version: saved.saved }));
      await queryClient.invalidateQueries({ queryKey: ["artifacts"] });
      onVersion(saved.saved);
    },
    onError: (failure) => {
      toast.error(failure.message);
      void queryClient.invalidateQueries({
        queryKey: ["artifacts", artifactId],
      });
    },
  });

  const restore = useMutation({
    mutationFn: ({ from, base }: { from: number; base: number }) =>
      pim.restoreArtifact(artifactId, from, base),
    onSuccess: async (restored, { from }) => {
      toast.success(
        t("artifactRestored", { from, version: restored.restored }),
      );
      // The new version must be in the history before the page shows it.
      await queryClient.invalidateQueries({ queryKey: ["artifacts"] });
      onVersion(restored.restored);
    },
    onError: (failure) => {
      toast.error(failure.message);
      void queryClient.invalidateQueries({
        queryKey: ["artifacts", artifactId],
      });
    },
  });

  const remove = useMutation({
    mutationFn: () => pim.deleteArtifact(artifactId),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["artifacts", artifactId] });
      void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
      toast.success(t("artifactDeletedToast"));
      onDeleted();
    },
    onError: (failure) => toast.error(failure.message),
  });

  if (error) {
    const gone = error instanceof ApiError && error.status === 404;
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-muted-foreground">
          {gone ? t("artifactDeleted") : error.message}
        </p>
        {onClose ? (
          <Button variant="outline" onClick={onClose}>
            {t("close")}
          </Button>
        ) : (
          <Button asChild variant="outline">
            <Link to="/artifacts">{t("allArtifacts")}</Link>
          </Button>
        )}
      </div>
    );
  }
  if (!artifact || version === undefined) return null;
  const current = artifact.history.find((entry) => entry.version === version);
  if (!current) {
    if (askedFor !== wanted) return null;
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-muted-foreground">
          {t("artifactVersionMissing", { version })}
        </p>
        <Button variant="outline" onClick={() => onVersion(artifact.version)}>
          {t("artifactLatest", { version: artifact.version })}
        </Button>
      </div>
    );
  }
  const isLatest = version === artifact.version;
  // The file the source view shows, with the version's files.
  const shown = source.data;
  const shownFile = shown?.files.find((entry) => entry.path === shown.path);

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <header className="flex h-13 shrink-0 items-center gap-2 border-b px-4">
        {/* Back where the person came from, such as their chat; to the list when the page was opened on its own. */}
        {!onClose &&
          (canGoBack ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-8 shrink-0"
              aria-label={t("back")}
              onClick={() => router.history.back()}
            >
              <ArrowLeft className="size-4" />
            </Button>
          ) : (
            <Button
              asChild
              size="icon"
              variant="ghost"
              className="size-8 shrink-0"
            >
              <Link to="/artifacts" aria-label={t("allArtifacts")}>
                <ArrowLeft className="size-4" />
              </Link>
            </Button>
          ))}
        <h1 className="min-w-0 flex-1 truncate font-semibold">
          {artifact.title}
        </h1>
        {artifact.history.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="h-8 shrink-0 gap-1 px-3"
                title={t("artifactHistory")}
              >
                {t("artifactVersionShort", { version })}
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-80 overflow-y-auto"
            >
              <DropdownMenuRadioGroup
                value={String(version)}
                onValueChange={(value) => onVersion(Number(value))}
              >
                {artifact.history.map((entry) => (
                  <DropdownMenuRadioItem
                    key={entry.version}
                    value={String(entry.version)}
                  >
                    {t(
                      entry.source === "restore"
                        ? "artifactVersionRestoredOption"
                        : entry.source === "person"
                          ? "artifactEditedBy"
                          : "artifactVersionOption",
                      {
                        version: entry.version,
                        from: entry.restoredFrom ?? 0,
                        date: formatDate(new Date(entry.createdAt), {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        }),
                      },
                    )}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {draft === null ? (
          <>
            <div className="flex rounded-full border p-0.5 text-sm">
              {(["preview", "source"] as const).map((mode) => {
                const label = t(
                  mode === "preview" ? "artifactPreview" : "artifactSource",
                );
                const Icon = mode === "preview" ? Eye : Code;
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={view === mode}
                    aria-label={label}
                    title={label}
                    onClick={() => setView(mode)}
                    className={cn(
                      "flex items-center rounded-full px-2.5 py-1 @2xl:px-3 @2xl:py-0.5",
                      view === mode && "bg-accent font-medium",
                    )}
                  >
                    <Icon className="size-3.5 @2xl:hidden" />
                    <span className="hidden @2xl:inline">{label}</span>
                  </button>
                );
              })}
            </div>
            <ShareMenu artifact={artifact} />
            {isLatest ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 @max-2xl:w-8 @max-2xl:px-0"
                aria-label={t("artifactEditSource")}
                title={t("artifactEditSource")}
                disabled={
                  (!source.data && source.isFetching) ||
                  source.data?.content === null
                }
                onClick={async () => {
                  const latest =
                    source.data ?? (await source.refetch()).data ?? null;
                  if (latest?.content != null) setDraft(latest.content);
                }}
              >
                <Pencil className="size-3.5" />
                <span className="hidden @2xl:inline">
                  {t("artifactEditSource")}
                </span>
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-8"
                disabled={restore.isPending}
                onClick={() =>
                  restore.mutate({ from: version, base: artifact.version })
                }
              >
                {t("artifactRestore")}
              </Button>
            )}
            {!onClose && isLatest && (
              <Button
                asChild
                size="sm"
                variant="outline"
                className="h-8 @max-2xl:w-8 @max-2xl:px-0"
              >
                <Link
                  to="/"
                  search={{ prompt: `/artifacts/${artifact.id}\n\n` }}
                  aria-label={t("chatWithAgent")}
                  title={t("artifactAsk")}
                >
                  <MessageCircle className="size-3.5" />
                  <span className="hidden @2xl:inline">
                    {t("chatWithAgent")}
                  </span>
                </Link>
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  aria-label={t("artifactOptions")}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <a
                    href={artifactDownloadUrl(
                      artifactId,
                      version,
                      view === "source" ? source.data?.path : undefined,
                    )}
                    download
                  >
                    <Download />
                    {t("download")}
                    <span className="ml-auto pl-4 text-muted-foreground text-xs">
                      {formatBytes(current.size, formatNumber)}
                    </span>
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={printing}
                  onSelect={() => setPrinting(true)}
                >
                  <Printer />
                  {t("artifactPrint")}
                </DropdownMenuItem>
                {!onClose && artifact.session && (
                  <DropdownMenuItem asChild>
                    <Link
                      to="/chat/$sessionId"
                      params={{ sessionId: artifact.session }}
                      search={{ artifact: artifactId, v: version }}
                    >
                      <MessageCircle />
                      {t("openChat")}
                    </Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={remove.isPending}
                  onSelect={() => {
                    if (
                      window.confirm(
                        t("artifactDeleteConfirm", { title: artifact.title }),
                      )
                    ) {
                      remove.mutate();
                    }
                  }}
                >
                  <Trash2 />
                  {t("artifactDelete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={() => setDraft(null)}
            >
              {t("cancel")}
            </Button>
            <Button
              size="sm"
              className="h-8"
              disabled={save.isPending || draft === source.data?.content}
              onClick={() =>
                save.mutate({ base: artifact.version, content: draft })
              }
            >
              {t("artifactSaveVersion")}
            </Button>
          </>
        )}
        {onClose && (
          <Button
            size="icon"
            variant="ghost"
            className="size-8 shrink-0"
            aria-label={t("close")}
            title={t("close")}
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2 md:p-3">
        {(view === "source" || draft !== null) &&
          shown &&
          shown.files.length > 1 && (
            <select
              aria-label={t("artifactFiles")}
              value={shown.path}
              disabled={draft !== null}
              onChange={(event) => setFile(event.target.value)}
              className="h-8 max-w-72 self-start rounded-full border bg-background px-3 font-mono text-xs disabled:opacity-50"
            >
              {shown.files.map((entry) => (
                <option key={entry.path} value={entry.path}>
                  {entry.path}
                </option>
              ))}
            </select>
          )}
        {draft !== null ? (
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={t("artifactSource")}
            spellCheck={artifact.kind === "markdown"}
            className="min-h-0 flex-1 resize-none rounded-lg border bg-background p-3 font-mono text-sm leading-6 outline-none scrollbar-thin focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20"
          />
        ) : view === "preview" ? (
          <div className="min-h-0 flex-1">
            <ArtifactPreview
              id={artifactId}
              version={version}
              kind={artifact.kind}
              title={artifact.title}
              fill
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
            {shown?.content === null ? (
              <p className="text-muted-foreground text-sm">
                {t("artifactBinaryFile", {
                  path: shown.path,
                  type: shownFile?.type ?? "",
                  size: formatBytes(shownFile?.size ?? 0, formatNumber),
                })}
              </p>
            ) : shown ? (
              <CodeBlock
                code={shown.content ?? ""}
                language={languageOf(shown.path, artifact.kind)}
              />
            ) : (
              <p className="text-muted-foreground text-sm">
                {source.error?.message ?? t("loading")}
              </p>
            )}
          </div>
        )}
        {printing && (
          <ArtifactPrint
            id={artifactId}
            version={version}
            kind={artifact.kind}
            title={artifact.title}
            onDone={donePrinting}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Shares the artifact with your circles, whose people then find its latest
 * version under Shared with you, and publishes a version of it for everyone
 * on this Pim, in Discover. Shown once there's someone to share with.
 */
function ShareMenu({ artifact }: { artifact: ArtifactDetail }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: account } = useQuery(accountQuery());
  const { data: circles } = useQuery(circlesQuery());
  const { data: publication } = useQuery(artifactPublicationQuery(artifact.id));
  const share = useMutation({
    mutationFn: (shared: string[]) =>
      pim.setArtifactCircles(artifact.id, shared),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["artifacts", artifact.id] }),
    onError: (failure) => toast.error(failure.message),
  });
  const publish = useMutation({
    mutationFn: async (change: { on: boolean; open?: boolean }) => {
      if (change.on) await pim.publishArtifact(artifact.id, change.open);
      else await pim.unpublishArtifact(artifact.id);
    },
    onSuccess: (_answer, change) => {
      if (change.open !== undefined) return;
      toast.success(
        change.on
          ? t("artifactPublished", { version: artifact.version })
          : t("artifactUnpublished"),
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["artifacts", artifact.id, "publication"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["published-artifacts"],
      });
    },
    onError: (failure) => toast.error(failure.message),
  });
  // Alone on this Pim, there is nobody to publish for, unless it already is.
  const canPublish = !!account && (!account.alone || !!publication);
  if (!circles?.length && !canPublish) return null;
  const shared = artifact.circles.filter((id) =>
    circles?.some((circle) => circle.id === id),
  );
  const label = t(
    shared.length || publication ? "artifactShared" : "artifactShare",
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant={shared.length || publication ? "secondary" : "outline"}
          className="h-8 @max-2xl:w-8 @max-2xl:px-0"
          aria-label={label}
          title={label}
        >
          <Users className="size-3.5" />
          <span className="hidden @2xl:inline">{label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {!!circles?.length && (
          <>
            <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
              {t("artifactShareHint")}
            </DropdownMenuLabel>
            {circles.map((circle) => (
              <DropdownMenuCheckboxItem
                key={circle.id}
                checked={shared.includes(circle.id)}
                disabled={share.isPending}
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) =>
                  share.mutate(
                    checked
                      ? [...shared, circle.id]
                      : shared.filter((id) => id !== circle.id),
                  )
                }
              >
                <span className="min-w-0 flex-1 truncate">{circle.name}</span>
                <span className="text-muted-foreground text-xs">
                  {circle.members.length}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </>
        )}
        {!!circles?.length && canPublish && <DropdownMenuSeparator />}
        {canPublish && (
          <>
            <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
              {publication
                ? t("artifactPublishedHint", { version: publication.version })
                : t("artifactPublishHint")}
            </DropdownMenuLabel>
            {(!publication || publication.version !== artifact.version) && (
              <DropdownMenuItem
                disabled={publish.isPending}
                onSelect={() => publish.mutate({ on: true })}
              >
                <Globe />
                {t("artifactPublish", { version: artifact.version })}
              </DropdownMenuItem>
            )}
            {publication && (
              <>
                <DropdownMenuItem asChild>
                  <Link
                    to="/artifacts/published/$publishedId"
                    params={{ publishedId: publication.id }}
                  >
                    <ExternalLink />
                    {t("artifactSeePublished")}
                  </Link>
                </DropdownMenuItem>
                {publication.linkable && (
                  <DropdownMenuCheckboxItem
                    checked={publication.public}
                    disabled={publish.isPending}
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(checked) =>
                      publish.mutate({ on: true, open: checked })
                    }
                  >
                    {t("artifactAnyoneWithLink")}
                  </DropdownMenuCheckboxItem>
                )}
                {publication.link && (
                  <DropdownMenuItem
                    onSelect={() => {
                      const link = publication.link ?? "";
                      void navigator.clipboard.writeText(link).then(
                        () => toast.success(t("artifactLinkCopied")),
                        () => toast(link),
                      );
                    }}
                  >
                    <Link2 />
                    {t("artifactCopyLink")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  disabled={publish.isPending}
                  onSelect={() => publish.mutate({ on: false })}
                >
                  <X />
                  {t("artifactUnpublish")}
                </DropdownMenuItem>
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The language a file's source is highlighted as, by its extension. */
function languageOf(path: string, kind: ArtifactKind) {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const languages = {
    html: "html",
    htm: "html",
    css: "css",
    js: "javascript",
    mjs: "javascript",
    jsx: "jsx",
    ts: "typescript",
    tsx: "tsx",
    json: "json",
    md: "markdown",
    svg: "xml",
  } as const;
  return extension in languages
    ? languages[extension as keyof typeof languages]
    : ARTIFACT_LANGUAGES[kind];
}
