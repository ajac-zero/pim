import type { ReactNode } from "react";

/**
 * The header above a chat, shared by every page that is laid out like one: a
 * title at the left, with its icon and status, and the page's actions at the
 * right. On narrow screens, where the sidebar gives way to the bottom bar, a
 * line runs under it.
 */
export function ChatHeader({
  title,
  actions,
}: {
  title: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex h-13 shrink-0 items-center gap-2 border-sidebar-border border-b px-4 md:border-b-0">
      <div className="flex min-w-0 flex-1 items-center gap-2 text-[15px]">
        {title}
      </div>
      {actions}
    </header>
  );
}
