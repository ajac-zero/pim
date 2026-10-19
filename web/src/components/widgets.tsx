import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useI18n } from "~/components/i18n";
import type {
  ExtensionText,
  ShownWidget,
  Widget,
  WidgetLink,
  WidgetListItem,
  WidgetProgressItem,
} from "~/lib/pim-api";
import { cn } from "~/lib/utils";

/**
 * A dashboard's card. Extensions send data of a known kind; the app draws
 * every kind itself, so no extension code runs here.
 */
export function WidgetCard({
  widget,
  actions,
}: {
  widget: Widget;
  /** Beside its title, such as taking it off a dashboard. */
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section
      className="group flex min-w-0 flex-col rounded-2xl bg-muted px-4 py-4"
      aria-label={widget.title}
    >
      <WidgetHeader title={widget.title} actions={actions} />
      {"failed" in widget ? (
        <p className="text-muted-foreground text-sm">{t("widgetFailed")}</p>
      ) : widget.items.length === 0 ? (
        <p className="text-muted-foreground text-sm">{widget.empty}</p>
      ) : widget.kind === "list" ? (
        <ul className="-mx-2 space-y-px">
          {widget.items.map((item, index) => (
            // Items have no ids: their order is all a widget gives.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <ListRow key={index} item={item} />
          ))}
        </ul>
      ) : (
        <ul className="-mx-2 space-y-px">
          {widget.items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: as for lists
            <ProgressRow key={index} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** A card's title, with its actions on the right, shown on hover or focus where there's a pointer. */
export function WidgetHeader({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-2 flex min-h-6 items-center gap-2">
      <h2 className="min-w-0 flex-1 truncate text-muted-foreground text-[13px]">
        {title}
      </h2>
      {actions && (
        <div className="-my-1 -mr-1.5 flex shrink-0 items-center gap-0.5 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:hover)]:opacity-0">
          {actions}
        </div>
      )}
    </div>
  );
}

function ListRow({ item }: { item: WidgetListItem }) {
  const { locale } = useI18n();
  return (
    <li>
      <ItemLink link={item.link}>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-[15px]">{item.title}</span>
          {item.detail && (
            <span className="block truncate text-muted-foreground text-xs">
              {item.detail}
            </span>
          )}
        </span>
        {item.time && (
          <time
            dateTime={item.time}
            className="shrink-0 pt-0.5 text-muted-foreground text-xs tabular-nums"
          >
            {formatTime(item.time, locale)}
          </time>
        )}
      </ItemLink>
    </li>
  );
}

function ProgressRow({ item }: { item: WidgetProgressItem }) {
  const share = item.max > 0 ? Math.min(item.value / item.max, 1) : 0;
  return (
    <li>
      <ItemLink link={item.link}>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[15px]">
              {item.title}
            </span>
            <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
              {item.value}/{item.max}
            </span>
          </span>
          <span
            className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={item.max}
            aria-valuenow={item.value}
            aria-label={item.title}
          >
            <span
              className="block h-full rounded-full bg-primary"
              style={{ width: `${share * 100}%` }}
            />
          </span>
          {item.detail && (
            <span className="mt-1 block truncate text-muted-foreground text-xs">
              {item.detail}
            </span>
          )}
        </span>
      </ItemLink>
    </li>
  );
}

const ROW = "flex items-start gap-3 rounded-lg px-2 py-1.5";

/** Extension text in `locale`, or English when it wasn't translated. */
function localize(text: ExtensionText, locale: string): string {
  return typeof text === "string" ? text : (text[locale] ?? text.en);
}

/**
 * The widgets a `send_to_user` result says went with the message, or null
 * when it says none: a plain "Sent.", or not here yet.
 */
export function shownWidgets(output: unknown): ShownWidget[] | null {
  if (typeof output !== "string" || !output.startsWith("{")) return null;
  try {
    const { widgets } = JSON.parse(output) as { widgets?: unknown };
    if (!Array.isArray(widgets)) return null;
    return widgets.filter(
      (widget): widget is ShownWidget =>
        typeof widget === "object" &&
        widget !== null &&
        typeof widget.id === "string" &&
        ("failed" in widget || Array.isArray(widget.items)),
    );
  } catch {
    return null;
  }
}

/**
 * A message's widgets, as they were when Pim sent it. Until the call's
 * result arrives (`widgets` is null), a placeholder for each one asked for.
 */
export function SentWidgets({
  requested,
  widgets,
}: {
  requested: number;
  widgets: readonly ShownWidget[] | null;
}) {
  const { locale } = useI18n();
  return (
    <div
      className={cn(
        "mt-3 grid gap-3",
        (widgets?.length ?? requested) > 1 && "sm:grid-cols-2",
      )}
    >
      {widgets
        ? widgets.map((widget) => (
            <WidgetCard
              key={widget.id}
              widget={{
                ...widget,
                title: localize(widget.title, locale),
                empty: localize(widget.empty, locale),
              }}
            />
          ))
        : Array.from({ length: requested }, (_, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have only their place
              key={index}
              className="h-24 animate-pulse rounded-2xl bg-muted"
            />
          ))}
    </div>
  );
}

function ItemLink({
  link,
  children,
}: {
  link?: WidgetLink;
  children: ReactNode;
}) {
  const className = cn(ROW, link && "hover:bg-muted");
  // An artifact with a chat opens beside it, in the canvas.
  if (link?.chat) {
    return (
      <Link
        to="/chat/$sessionId"
        params={{ sessionId: link.chat }}
        search={"artifact" in link ? { artifact: link.artifact } : {}}
        className={className}
      >
        {children}
      </Link>
    );
  }
  if (link && "artifact" in link) {
    return (
      <Link
        to="/artifacts/$artifactId"
        params={{ artifactId: link.artifact }}
        className={className}
      >
        {children}
      </Link>
    );
  }
  return <div className={className}>{children}</div>;
}

const DAY = 24 * 60 * 60 * 1000;

/** Within a week either way, the weekday and time; further, the date. */
function formatTime(iso: string, locale: string): string {
  const date = new Date(iso);
  const near = Math.abs(date.getTime() - Date.now()) < 6 * DAY;
  return new Intl.DateTimeFormat(
    locale,
    near
      ? { weekday: "short", hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric" },
  ).format(date);
}
