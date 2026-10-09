import { memo } from "react";
import type { BundledLanguage } from "shiki";
import { Streamdown } from "streamdown";
import {
  CodeBlock,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "~/components/ui/code-block";
import { cn } from "~/lib/utils";

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
export const Markdown = memo(function Markdown({
  text,
  className,
  streaming,
}: {
  text: string;
  className?: string;
  /** Disables copy affordances and incomplete-code-fence hooks while true. */
  streaming?: boolean;
}) {
  return (
    <div
      className={cn(
        "max-w-none break-words text-[15px] leading-7",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      <Streamdown
        isAnimating={streaming}
        components={{
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
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2 transition-colors hover:decoration-foreground"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto rounded-lg border scrollbar-thin">
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
              className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[0.85em]"
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
