import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { memo, type ReactNode } from "react";
import type { BundledLanguage } from "shiki";
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
  type StreamdownProps,
} from "streamdown";

type PluggableList = NonNullable<StreamdownProps["rehypePlugins"]>;
type Pluggable = PluggableList[number];

import { AgentIcon } from "~/components/agent-icon";
import { useI18n } from "~/components/i18n";
import {
  CodeBlock,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "~/components/ui/code-block";
import { agentsQuery, sessionsQuery } from "~/lib/queries";
import { showTab } from "~/lib/tabs";
import { cn } from "~/lib/utils";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A chat an agent names in its text: by its id, or by its address. */
const CHAT_MENTION = new RegExp(`(?:/chat/)?\\b(${UUID})\\b`, "gi");
/** A link to a chat in this app. */
const CHAT_HREF = new RegExp(`^(https?://[^/]+)?/chat/(${UUID})$`, "i");
/** A link to an artifact in this app, perhaps to one of its versions. */
const ARTIFACT_HREF = new RegExp(
  `^(https?://[^/]+)?/artifacts/(${UUID})(?:\\?v=(\\d+))?$`,
  "i",
);
/** An artifact named by an address an agent made up, such as `artifact://<id>`, which browsers can't open. */
const ARTIFACT_SCHEME = new RegExp(`^artifacts?:(?://)?(${UUID})$`, "i");
/** Link text that is only the chat's id or address, which its title reads better than. */
const BARE_CHAT = new RegExp(`^(?:(?:https?://[^/\\s]+)?/chat/)?${UUID}$`, "i");

type MdastNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
};

/**
 * Makes the chats an agent names into links: an id, bare or in backticks,
 * and a `/chat/<id>` address. An id that turns out not to be a chat (an
 * artifact's or an approval's) is shown as text again by `ChatLink`.
 */
function remarkChatLinks() {
  const link = (text: string, id: string): MdastNode => ({
    type: "link",
    url: `/chat/${id.toLowerCase()}`,
    children: [{ type: "text", value: text }],
  });
  const mentions = (text: string): MdastNode[] => {
    const nodes: MdastNode[] = [];
    let last = 0;
    for (const match of text.matchAll(CHAT_MENTION)) {
      if (match.index > last) {
        nodes.push({ type: "text", value: text.slice(last, match.index) });
      }
      nodes.push(link(match[0], match[1] as string));
      last = match.index + match[0].length;
    }
    if (last < text.length)
      nodes.push({ type: "text", value: text.slice(last) });
    return nodes;
  };
  const visit = (node: MdastNode) => {
    const artifact =
      node.type === "link" && ARTIFACT_SCHEME.exec(node.url ?? "");
    if (artifact) node.url = `/artifacts/${artifact[1]}`;
    // Text already in a link stays that link's.
    if (!node.children || node.type === "link" || node.type === "linkReference")
      return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text" && child.value) return mentions(child.value);
      if (
        child.type === "inlineCode" &&
        child.value &&
        BARE_CHAT.test(child.value)
      ) {
        return [link(child.value, child.value.slice(-36))];
      }
      visit(child);
      return [child];
    });
  };
  return (tree: MdastNode) => visit(tree);
}

const chatRemarkPlugins: PluggableList = [
  ...Object.values(defaultRemarkPlugins),
  remarkChatLinks as Pluggable,
];

/** Whether a link's origin, when it names one, is this app's. */
function inApp(origin: string | undefined): boolean {
  return (
    !origin || (typeof location !== "undefined" && origin === location.origin)
  );
}

/** The chat a link goes to, when it goes to one in this app. */
function chatOf(href: string | undefined): string | undefined {
  const match = href ? CHAT_HREF.exec(href) : null;
  if (!match || !inApp(match[1])) return undefined;
  return match[2]?.toLowerCase();
}

/** The artifact a link goes to, and which version, when it goes to one in this app. */
function artifactOf(
  href: string | undefined,
): { id: string; version?: number } | undefined {
  const match = href ? ARTIFACT_HREF.exec(href) : null;
  if (!match?.[2] || !inApp(match[1])) return undefined;
  return {
    id: match[2].toLowerCase(),
    ...(match[3] ? { version: Number(match[3]) } : {}),
  };
}

const LINK_CLASS =
  "text-link underline underline-offset-2 transition-colors hover:decoration-foreground";

/**
 * An artifact an agent's message links to, opened in the canvas beside the
 * chat the message is in, like the artifact's own card; on its own page
 * where there's no chat around it.
 */
function ArtifactLink({
  id,
  version,
  children,
}: {
  id: string;
  version?: number;
  children: ReactNode;
}) {
  const sessionId = useParams({
    strict: false,
    select: (params) => params.sessionId,
  });
  return sessionId ? (
    <Link
      to="/chat/$sessionId"
      params={{ sessionId }}
      search={{ artifact: id, v: version }}
      className={LINK_CLASS}
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/artifacts/$artifactId"
      params={{ artifactId: id }}
      search={{ v: version }}
      className={LINK_CLASS}
    >
      {children}
    </Link>
  );
}

/**
 * A chat an agent's message names: its agent's icon and its title, opening
 * it in a tab of its own. An id that names none of the person's chats stays
 * as it was written.
 */
function ChatLink({ id, children }: { id: string; children: ReactNode }) {
  const { t } = useI18n();
  const { data: sessions } = useQuery(sessionsQuery());
  const { data: agents } = useQuery(agentsQuery());
  const chat = sessions?.find((session) => session.id === id);
  if (!chat) return <>{children}</>;
  const agent = chat.visit
    ? undefined
    : agents?.find((candidate) =>
        chat.agent ? candidate.id === chat.agent.id : candidate.majordomo,
      );
  const title = chat.title ?? t("newChat");
  const bare = typeof children === "string" && BARE_CHAT.test(children);
  return (
    <Link
      to="/chat/$sessionId"
      params={{ sessionId: id }}
      title={title}
      onClick={(event) => {
        // A click the browser opens elsewhere leaves this window's tabs alone.
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        showTab(id, true);
      }}
      className={LINK_CLASS}
    >
      {agent && (
        <AgentIcon
          agent={agent}
          tile
          className="mr-1 inline-flex size-4 rounded align-[-3px]"
        />
      )}
      {bare ? title : children}
    </Link>
  );
}

/**
 * Chat-tuned markdown. Styled to feel like ChatGPT: comfortable line height,
 * tight headings, bordered tables, and syntax-highlighted code blocks.
 *
 * Rendered with Streamdown (https://streamdown.ai) instead of a hand-rolled
 * react-markdown setup: it's purpose-built for streaming LLM output, safely
 * parsing incomplete/unterminated markdown (e.g. an unclosed code fence or
 * list mid-stream) instead of rendering it as broken raw text.
 *
 * Fenced code blocks are still rendered with our own CodeBlock component
 * (see ~/components/ui/code-block) — Streamdown's own Shiki-powered code
 * plugin is intentionally not installed, so there's a single source of
 * truth for code highlighting.
 */
/** Links an untrusted text may keep: web and mail addresses, and places on the same page. */
function safeLink(href: string | undefined): boolean {
  return href !== undefined && /^(https?:|mailto:|#)/i.test(href);
}

/** Streamdown's sanitizer (rehype-sanitize), run here with a schema of Pim's own. */
const sanitize = (defaultRehypePlugins.sanitize as [Pluggable, unknown])[0];

/**
 * What untrusted Markdown may become, and nothing else: text formatting,
 * lists, tables, code, and links to web and mail addresses. No raw HTML is
 * parsed (Streamdown's `raw` plugin isn't run), and this allowlist drops
 * every element and attribute that could load or run something: images keep
 * only their alt text, and there are no `picture`, `source`, media, frames,
 * forms, styles or event handlers.
 */
export const UNTRUSTED_SCHEMA = {
  tagNames: [
    "a",
    "b",
    "blockquote",
    "br",
    "code",
    "del",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "input",
    "li",
    "ol",
    "p",
    "pre",
    "s",
    "span",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
  ],
  attributes: {
    a: ["href"],
    code: [["className", /^language-[\w-]+$/]],
    img: ["alt"],
    input: [["type", "checkbox"], ["disabled", true], "checked"],
    li: [["className", "task-list-item"]],
    ol: ["start", ["className", "contains-task-list"]],
    ul: [["className", "contains-task-list"]],
    td: ["align"],
    th: ["align"],
  },
  required: { input: { type: "checkbox", disabled: true } },
  protocols: { href: ["http", "https", "mailto"] },
  ancestors: {
    tbody: ["table"],
    td: ["table"],
    th: ["table"],
    thead: ["table"],
    tr: ["table"],
  },
  strip: ["script", "style"],
  clobber: [],
  clobberPrefix: "",
};

const untrustedRehypePlugins: PluggableList = [
  [sanitize, UNTRUSTED_SCHEMA] as Pluggable,
  // Link hardening as well, behind the schema.
  ...(defaultRehypePlugins.harden ? [defaultRehypePlugins.harden] : []),
];

/** No images: one from elsewhere would be fetched, and could carry what the text knows. Its alt text stands in. */
const untrustedComponents = {
  img: (props: object) => {
    const { alt } = props as { alt?: unknown };
    return (
      <span className="text-muted-foreground">
        [{typeof alt === "string" && alt !== "" ? alt : "image"}]
      </span>
    );
  },
};

export const Markdown = memo(function Markdown({
  text,
  className,
  streaming,
  untrusted,
}: {
  text: string;
  className?: string;
  /** Disables copy affordances and incomplete-code-fence hooks while true. */
  streaming?: boolean;
  /**
   * For text kept and shown again, such as a Markdown artifact: raw HTML is
   * dropped, images are replaced by their alt text, so showing it loads
   * nothing from elsewhere, and links only go to web or mail addresses.
   */
  untrusted?: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 max-w-full break-words text-[15px] leading-6 [overflow-wrap:anywhere]",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      <Streamdown
        isAnimating={streaming}
        skipHtml={untrusted}
        {...(untrusted
          ? { rehypePlugins: untrustedRehypePlugins }
          : { remarkPlugins: chatRemarkPlugins })}
        components={{
          ...(untrusted ? untrustedComponents : {}),
          h1: ({ children }) => (
            <h1 className="mt-6 mb-3 font-semibold text-2xl">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-6 mb-3 font-semibold text-xl">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-5 mb-2 font-semibold text-lg">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mt-4 mb-2 font-semibold">{children}</h4>
          ),
          p: ({ children }) => <p className="my-3">{children}</p>,
          ul: ({ children }) => (
            <ul className="my-3 list-disc space-y-1.5 pl-6">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-3 list-decimal space-y-1.5 pl-6">{children}</ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-border border-l-2 pl-4 text-muted-foreground">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-6 border-border" />,
          a: ({ href, children }) =>
            !untrusted && chatOf(href) ? (
              <ChatLink id={chatOf(href) as string}>{children}</ChatLink>
            ) : !untrusted && artifactOf(href) ? (
              <ArtifactLink {...(artifactOf(href) as { id: string })}>
                {children}
              </ArtifactLink>
            ) : untrusted && !safeLink(href) ? (
              <span>{children}</span>
            ) : (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className={LINK_CLASS}
              >
                {children}
              </a>
            ),
          table: ({ children }) => (
            <div className="my-4 max-w-full overflow-x-auto rounded-xl bg-background scrollbar-thin">
              <table className="w-full border-collapse text-sm">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-muted/50 text-left">{children}</thead>
          ),
          th: ({ children }) => (
            <th className="border-border border-b px-3 py-2 font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-border border-b px-3 py-2 last:border-b-0">
              {children}
            </td>
          ),
          // Inline `code` spans (single backticks). Fenced blocks are
          // handled separately below by `code`, so this only ever receives
          // inline content.
          inlineCode: ({ children, ...props }) => (
            <code
              className="rounded-md bg-background/80 px-1.5 py-0.5 font-mono text-[0.875em] text-destructive"
              {...props}
            >
              {children}
            </code>
          ),
          // Fenced code blocks (triple backticks). Streamdown routes inline
          // spans to `inlineCode` above, so this only ever receives blocks.
          code: ({ className, children }) => {
            const match = /language-(\w+)/.exec(className ?? "");
            const language = (match?.[1] ?? "text") as BundledLanguage;
            return (
              <CodeBlock
                code={String(children).replace(/\n$/, "")}
                language={language}
              >
                <CodeBlockHeader>
                  <CodeBlockTitle>
                    <CodeBlockFilename>{language}</CodeBlockFilename>
                  </CodeBlockTitle>
                  <CodeBlockCopyButton />
                </CodeBlockHeader>
              </CodeBlock>
            );
          },
          // No `pre` override: Streamdown's default `pre` component flattens
          // itself to just its child `code` element while tagging it with
          // `data-block="true"` — that tag is how `code` above is told
          // "this is a fenced block" vs. "this is an inline span". Overriding
          // `pre` with a bare passthrough (as react-markdown required) drops
          // that tag and silently breaks block-code detection.
        }}
      >
        {text}
      </Streamdown>
    </div>
  );
});
