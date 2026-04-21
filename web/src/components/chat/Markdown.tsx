import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

type Props = { text: string };

function MarkdownBase({ text }: Props) {
  return (
    <div className="markdown-body prose prose-invert max-w-none text-sm leading-6">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true, detect: true }]]}
        components={{
          a: (props) => (
            <a {...props} target="_blank" rel="noreferrer" className="text-accent underline" />
          ),
          code: ({ className, children, ...rest }) => {
            const inline = !/language-/.test(className ?? "");
            if (inline) {
              return (
                <code
                  className="rounded bg-surface px-1 py-0.5 font-mono text-[12px]"
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
          pre: (props) => (
            <pre
              {...props}
              className="overflow-auto rounded bg-bg p-3 font-mono text-[12px] leading-5"
            />
          ),
          table: (props) => (
            <div className="overflow-auto">
              <table {...props} className="my-2 w-full border-collapse text-[13px]" />
            </div>
          ),
          th: (props) => (
            <th
              {...props}
              className="border border-border bg-surface/60 px-2 py-1 text-left font-semibold"
            />
          ),
          td: (props) => <td {...props} className="border border-border px-2 py-1 align-top" />,
          ul: (props) => <ul {...props} className="list-disc space-y-1 pl-5" />,
          ol: (props) => <ol {...props} className="list-decimal space-y-1 pl-5" />,
          h1: (props) => <h1 {...props} className="mt-3 text-lg font-semibold" />,
          h2: (props) => <h2 {...props} className="mt-3 text-base font-semibold" />,
          h3: (props) => <h3 {...props} className="mt-2 text-sm font-semibold" />,
          blockquote: (props) => (
            <blockquote
              {...props}
              className="border-l-2 border-border pl-3 text-fg-muted"
            />
          ),
          hr: (props) => <hr {...props} className="my-3 border-border" />,
          p: (props) => <p {...props} className="my-1.5 whitespace-pre-wrap" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownBase, (prev, next) => prev.text === next.text);
