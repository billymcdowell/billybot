import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";

// react-markdown never renders raw HTML, so a model can't inject markup. Two more things are
// handled here on purpose:
//  - Links open in your browser. Letting the window follow one would replace the whole app.
//  - Images are not loaded. A remote image URL can smuggle text out of the app in its address,
//    so they show as a plain label instead.
const components: Components = {
  h1: ({ children }) => <h1 className="text-lg font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="text-base font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold">{children}</h3>,
  h4: ({ children }) => <h4 className="text-sm font-medium">{children}</h4>,
  h5: ({ children }) => <h5 className="text-sm font-medium">{children}</h5>,
  h6: ({ children }) => <h6 className="text-sm font-medium text-muted-foreground">{children}</h6>,
  p: ({ children }) => <p className="leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5 [&_ol]:mt-1 [&_ul]:mt-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 [&_ol]:mt-1 [&_ul]:mt-1">{children}</ol>,
  li: ({ children }) => <li className="mt-1 leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 pl-3 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-1" />,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  a: ({ href, children }) => (
    <a
      href={href}
      title={href}
      className="text-primary underline underline-offset-2"
      onClick={(e) => {
        e.preventDefault();
        if (href && /^(https?:|mailto:)/i.test(href)) openUrl(href).catch(() => {});
      }}
    >
      {children}
    </a>
  ),
  img: ({ alt }) => <span className="text-muted-foreground">[image{alt ? `: ${alt}` : ""}]</span>,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border px-2 py-1 align-top">{children}</td>,
  // Fenced blocks arrive as <pre><code>; the CodeBlock below replaces both.
  pre: ({ children }) => <>{children}</>,
  code: ({ children }: { children?: ReactNode }) => {
    const text = String(children ?? "");
    // Inline code never contains a line break; fenced code always ends with one.
    if (!text.includes("\n")) {
      return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>;
    }
    return (
      <CodeBlock size="sm">
        <CodeBlockContent wrap className="max-h-96">
          {text.replace(/\n$/, "")}
        </CodeBlockContent>
      </CodeBlock>
    );
  },
};

/** A model reply, rendered as Markdown. */
const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});

export default Markdown;
