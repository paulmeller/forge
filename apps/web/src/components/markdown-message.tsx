import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="mt-3 text-[1.5em] font-semibold text-foreground first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-3 text-[1.3em] font-semibold text-foreground first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-2.5 text-[1.15em] font-semibold text-foreground first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-2 text-[1.05em] font-semibold text-foreground first:mt-0">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="mt-2 font-semibold text-foreground first:mt-0">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="mt-2 font-semibold text-foreground first:mt-0">{children}</h6>
  ),
  p: ({ children }) => <p className="mt-1.5 first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className="mt-1.5 list-disc pl-5 first:mt-0">{children}</ul>,
  ol: ({ children }) => <ol className="mt-1.5 list-decimal pl-5 first:mt-0">{children}</ol>,
  li: ({ children }) => <li className="mt-0.5">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[13px]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="mt-1.5 overflow-x-auto rounded-md bg-muted/50 p-3 font-mono text-[13px] first:mt-0 [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
};

export function MarkdownMessage({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
}
