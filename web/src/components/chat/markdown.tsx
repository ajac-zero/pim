import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { isValidElement, memo, type ReactNode } from "react";
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
import {
  Diagram,
  isReplyBlock,
  ReplyBlock,
} from "~/components/chat/reply-blocks";
import { FileLink } from "~/components/file-link";
import { useI18n } from "~/components/i18n";
import {
  CodeBlock,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "~/components/ui/code-block";
import { type Agent, FILES_ROOT } from "~/lib/pim-api";
import {
  agentsQuery,
  majordomoQuery,
  profileQuery,
  sessionsQuery,
} from "~/lib/queries";
import { openTab } from "~/lib/tabs";
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

/** Where the link around a text that mentions agents goes, which `a` swaps for the mentions themselves. */
const MENTIONS_HREF = "#pim-mentions";
/** An @ that starts a word, as in `@Coach` but not in `ada@example.com`. */
const AT = /(?:^|[^\p{L}\p{N}_])@/u;

type MdastNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
};

/**
 * Makes the chats a message names into links: an id, bare or in backticks,
 * and a `/chat/<id>` address. An id that turns out not to be a chat (an
 * artifact's or an approval's) is shown as text again by `ChatLink`.
 * Workspace file links, including `sandbox:` addresses from older replies,
 * go to the file viewer before Markdown's sanitizer checks their protocol.
 */
function remarkChatLinks(options?: { agents?: boolean }) {
  const mentionAgents = options?.agents;
  const link = (text: string, id: string): MdastNode => ({
    type: "link",
    url: `/chat/${id.toLowerCase()}`,
    children: [{ type: "text", value: text }],
  });
  const mentions = (text: string): MdastNode[] => {
    // A text that mentions someone is kept whole: `Mentions` finds who, as it knows the agents.
    if (mentionAgents && AT.test(text)) {
      return [
        {
          type: "link",
          url: MENTIONS_HREF,
          children: [{ type: "text", value: text }],
        },
      ];
    }
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
    if (node.type === "link" && node.url) {
      const path = node.url.replace(/^sandbox:/i, "");
      if (path.startsWith(`${FILES_ROOT}/`)) {
        try {
          node.url = `/files?path=${encodeURIComponent(decodeURIComponent(path))}`;
        } catch {
          // An invalid percent escape stays subject to the usual link checks.
        }
      }
    }
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
  [remarkChatLinks, { agents: true }] as Pluggable,
];

/**
 * Keeps the line breaks a person typed. Markdown joins lines that aren't
 * separated by a blank one, which suits a model's writing but not a message
 * typed with Shift+Enter between its lines.
 */
function remarkBreaks() {
  const visit = (node: MdastNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child): MdastNode[] => {
      if (child.type !== "text" || !child.value?.includes("\n")) {
        visit(child);
        return [child];
      }
      return child.value
        .split("\n")
        .flatMap((line, index): MdastNode[] => [
          ...(index > 0 ? [{ type: "break" }] : []),
          ...(line ? [{ type: "text", value: line }] : []),
        ]);
    });
  };
  return (tree: MdastNode) => visit(tree);
}

const bubbleRemarkPlugins: PluggableList = [
  ...Object.values(defaultRemarkPlugins),
  remarkBreaks as Pluggable,
  [remarkChatLinks, { agents: true }] as Pluggable,
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

/** A file-viewer or content link in this app; explicit downloads stay downloads. */
function fileOf(href: string | undefined): string | undefined {
  const match = href
    ? /^(https?:\/\/[^/]+)?\/(?:files|api\/files\/content)\?([^#]*)/.exec(href)
    : null;
  if (!match || !inApp(match[1])) return undefined;
  const search = new URLSearchParams(match[2]);
  if (search.has("download")) return undefined;
  const path = search.get("path");
  return path?.startsWith(`${FILES_ROOT}/`) ? path : undefined;
}

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

/** The text in `node`, through the spans a streaming message's words are in. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return isValidElement<{ children?: ReactNode }>(node)
    ? textOf(node.props.children)
    : "";
}

/**
 * A chat a message names: its agent's icon and its title, opening it in a
 * tab of its own. An id that names none of the person's chats stays as it
 * was written.
 */
function ChatLink({
  id,
  className = LINK_CLASS,
  children,
}: {
  id: string;
  className?: string;
  children: ReactNode;
}) {
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
  const bare = BARE_CHAT.test(textOf(children));
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
        openTab(id);
      }}
      className={className}
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

/** The names an agent can mention you by: your username, the name you gave your majordomo and your profile's name. */
export function useUserNames(): string[] {
  const { data: profile } = useQuery(profileQuery());
  const { data: majordomo } = useQuery(majordomoQuery());
  return [
    ...new Set(
      [profile?.username, majordomo?.yourName, profile?.displayName].filter(
        (name): name is string => !!name,
      ),
    ),
  ];
}

/** Whether a text mentions the person, as `@` and any of their names, as the Worker decides it. */
export function mentionsUser(text: string, names: readonly string[]): boolean {
  const keys = names.map((name) => name.toLowerCase()).filter(Boolean);
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(/@/g)) {
    if (match.index > 0 && /[\p{L}\p{N}_]/u.test(lower[match.index - 1] ?? ""))
      continue;
    if (
      keys.some(
        (key) =>
          lower.startsWith(key, match.index + 1) &&
          !/[\p{L}\p{N}_]/u.test(lower[match.index + 1 + key.length] ?? ""),
      )
    )
      return true;
  }
  return false;
}

/**
 * A text with agents mentioned in it, as `@Name` or `@Role` as Pim's agents
 * mention each other: each mention is shown as a chip, and opens that agent.
 * Names are matched as the Worker does, the longest first, and a name two
 * agents share mentions neither. The person's own `@username` is a chip too,
 * which opens nothing. What isn't a name stays as written.
 */
function Mentions({ text, chip }: { text: string; chip: string }) {
  const { data: agents } = useQuery(agentsQuery());
  const userNames = useUserNames();
  const names = new Map<string, number>();
  for (const agent of agents ?? []) {
    const key = agent.name.toLowerCase();
    names.set(key, (names.get(key) ?? 0) + 1);
  }
  const keys: { key: string; agent: Agent | undefined }[] = [
    ...(agents ?? [])
      .flatMap((agent) => [
        { key: agent.role.toLowerCase(), agent },
        ...(names.get(agent.name.toLowerCase()) === 1
          ? [{ key: agent.name.toLowerCase(), agent }]
          : []),
      ])
      .filter(({ key }) => key !== ""),
    ...userNames.map((name) => ({ key: name.toLowerCase(), agent: undefined })),
  ].sort((a, b) => b.key.length - a.key.length);
  const lower = text.toLowerCase();
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of lower.matchAll(/@/g)) {
    if (match.index < last) continue;
    if (match.index > 0 && /[\p{L}\p{N}_]/u.test(lower[match.index - 1] ?? ""))
      continue;
    const rest = lower.slice(match.index + 1);
    const hit = keys.find(
      ({ key }) =>
        rest.startsWith(key) && !/[\p{L}\p{N}_]/u.test(rest[key.length] ?? ""),
    );
    if (!hit) continue;
    const end = match.index + 1 + hit.key.length;
    if (match.index > last) nodes.push(text.slice(last, match.index));
    nodes.push(
      hit.agent ? (
        <Link
          key={match.index}
          to="/agents/$agentId"
          params={{ agentId: hit.agent.id }}
          title={hit.agent.name}
          className={cn(
            "rounded px-1 font-medium no-underline transition-colors",
            chip,
          )}
        >
          {text.slice(match.index, end)}
        </Link>
      ) : (
        <span
          key={match.index}
          className={cn("rounded px-1 font-medium", chip)}
        >
          {text.slice(match.index, end)}
        </span>
      ),
    );
    last = end;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
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

/** Where Pim serves its own images: those a person sent, and the copies Pim keeps of those an agent's reply shows. */
const OWN_IMAGE = /^\/api\/images\/[\w-]+$/;

/**
 * An agent's message shows only Pim's own images. One from elsewhere would be
 * fetched as soon as the message shows, and its address could carry what the
 * agent read: a page it read could tell it to write such an image. Its alt
 * text stands in.
 */
const agentComponents = {
  img: (props: object) => {
    const { src, alt } = props as { src?: unknown; alt?: unknown };
    const label = typeof alt === "string" ? alt : "";
    return typeof src === "string" && OWN_IMAGE.test(src) ? (
      <img src={src} alt={label} className="my-3 max-w-full rounded-xl" />
    ) : (
      <span className="text-muted-foreground">[{label || "image"}]</span>
    );
  },
  // A `<picture>`'s sources would load in place of its image.
  source: () => null,
};

/** Colors for text on the canvas or a card, and for text in a person's bubble, which takes them from the bubble's own. */
const TONES = {
  page: {
    link: LINK_CLASS,
    chip: "bg-link/10 text-link hover:bg-link/20",
    code: "bg-foreground/[0.06] text-destructive",
    quote: "border-border text-muted-foreground",
    line: "border-border",
    head: "bg-muted/50",
  },
  bubble: {
    link: "underline underline-offset-2",
    chip: "bg-current/15 hover:bg-current/25",
    code: "bg-background/50",
    quote: "border-current/40",
    line: "border-current/25",
    head: "bg-background/50",
  },
};

export const Markdown = memo(function Markdown({
  text,
  className,
  streaming,
  untrusted,
  bubble,
}: {
  text: string;
  className?: string;
  /**
   * While true, copy affordances and incomplete-code-fence hooks are off, and
   * new words fade in one after another. Pim sends a reply being written a
   * few times a second, so without the fade each batch would appear at once.
   */
  streaming?: boolean;
  /**
   * For text kept and shown again, such as a Markdown artifact: raw HTML is
   * dropped, images are replaced by their alt text, so showing it loads
   * nothing from elsewhere, and links only go to web or mail addresses.
   */
  untrusted?: boolean;
  /**
   * For what a person wrote, in their bubble: shown as `untrusted` text is,
   * with their line breaks kept, headings as bold paragraphs, and colors
   * from the bubble.
   */
  bubble?: boolean;
}) {
  const safe = untrusted || bubble;
  const tone = bubble ? TONES.bubble : TONES.page;
  const heading = (props: object) => (
    <p className="my-3 font-semibold">
      {(props as { children?: ReactNode }).children}
    </p>
  );
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
        animated
        // Streaming mode closes unclosed Markdown, as a reply still being
        // written needs. Finished text keeps what was written, so a lone `*`
        // doesn't get a second one added at its end.
        mode={streaming ? "streaming" : "static"}
        skipHtml={safe}
        {...(safe
          ? {
              rehypePlugins: untrustedRehypePlugins,
              ...(bubble ? { remarkPlugins: bubbleRemarkPlugins } : {}),
            }
          : { remarkPlugins: chatRemarkPlugins })}
        components={{
          ...(safe ? untrustedComponents : agentComponents),
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
          // Headings are too loud in a bubble.
          ...(bubble
            ? {
                h1: heading,
                h2: heading,
                h3: heading,
                h4: heading,
                h5: heading,
                h6: heading,
              }
            : {}),
          p: ({ children }) => <p className="my-3">{children}</p>,
          ul: ({ children }) => (
            <ul className="my-3 list-disc space-y-1.5 pl-6">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-3 list-decimal space-y-1.5 pl-6">{children}</ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className={cn("my-3 border-l-2 pl-4", tone.quote)}>
              {children}
            </blockquote>
          ),
          hr: () => <hr className={cn("my-6", tone.line)} />,
          a: ({ href, children }) =>
            href === MENTIONS_HREF ? (
              <Mentions text={textOf(children)} chip={tone.chip} />
            ) : // A person may name their own chats too; untrusted text may not.
            (!safe || bubble) && chatOf(href) ? (
              <ChatLink id={chatOf(href) as string} className={tone.link}>
                {children}
              </ChatLink>
            ) : !safe && artifactOf(href) ? (
              <ArtifactLink {...(artifactOf(href) as { id: string })}>
                {children}
              </ArtifactLink>
            ) : !safe && fileOf(href) ? (
              <FileLink path={fileOf(href) as string} className={tone.link}>
                {children}
              </FileLink>
            ) : safe && !safeLink(href) ? (
              <span>{children}</span>
            ) : (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className={tone.link}
              >
                {children}
              </a>
            ),
          table: ({ children }) => (
            <div
              className={cn(
                "my-4 max-w-full overflow-x-auto rounded-xl border scrollbar-thin",
                tone.line,
              )}
            >
              <table className="w-full border-collapse text-sm">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className={cn("text-left", tone.head)}>{children}</thead>
          ),
          th: ({ children }) => (
            <th className="px-3 py-2 font-semibold">{children}</th>
          ),
          td: ({ children }) => (
            // A line above each body cell: between rows, and under the header, but not under the table's border.
            <td className={cn("border-t px-3 py-2", tone.line)}>{children}</td>
          ),
          // Inline `code` spans (single backticks). Fenced blocks are
          // handled separately below by `code`, so this only ever receives
          // inline content.
          inlineCode: ({ children, ...props }) => (
            <code
              className={cn(
                "rounded-md px-1.5 py-0.5 font-mono text-[0.875em]",
                tone.code,
              )}
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
            const source = String(children).replace(/\n$/, "");
            const code = (
              <CodeBlock code={source} language={language}>
                <CodeBlockHeader>
                  <CodeBlockTitle>
                    <CodeBlockFilename>{language}</CodeBlockFilename>
                  </CodeBlockTitle>
                  <CodeBlockCopyButton />
                </CodeBlockHeader>
              </CodeBlock>
            );
            // An agent's cards, galleries and diagrams are drawn; anyone else's are code.
            if (safe) return code;
            if (isReplyBlock(language)) {
              return (
                <ReplyBlock kind={language} source={source} fallback={code} />
              );
            }
            return language === "mermaid" ? (
              <Diagram source={source} fallback={code} />
            ) : (
              code
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
