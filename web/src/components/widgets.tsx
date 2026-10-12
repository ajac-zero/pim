import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useI18n } from "~/components/i18n";
import type {
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
export function WidgetCard({ widget }: { widget: Widget }) {
  const { t } = useI18n();
  return (
    <section
      className="flex min-w-0 flex-col rounded-xl border bg-card px-4 py-3"
      aria-label={widget.title}
    >
      <h2 className="mb-2 font-medium text-sm">{widget.title}</h2>
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

function ListRow({ item }: { item: WidgetListItem }) {
  const { locale } = useI18n();
  return (
    <li>
      <ItemLink link={item.link}>
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-sm">{item.title}</span>
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
            <span className="min-w-0 flex-1 truncate text-sm">
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

function ItemLink({
  link,
  children,
}: {
  link?: WidgetLink;
  children: ReactNode;
}) {
  const className = cn(ROW, link && "hover:bg-muted");
  if (link && "chat" in link) {
    return (
      <Link
        to="/chat/$sessionId"
        params={{ sessionId: link.chat }}
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
