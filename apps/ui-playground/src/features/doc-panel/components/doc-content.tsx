import { CodeBlock } from '@/components/code-block';
import { Alert, AlertDescription } from '@arcaai/ui/alert';
import { Badge } from '@arcaai/ui/badge';
import { Separator } from '@arcaai/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface DocContentProps {
  content: string;
}

type CodeTab = { label: string; code: string };
type NodeProps = { children?: ReactNode };
type LinkNodeProps = { href?: string; children?: ReactNode };

type DocBlock = { type: 'markdown'; content: string } | { type: 'tabbed'; content: string; example: string };

type MarkdownSegment = { type: 'markdown'; content: string } | { type: 'code-tabs'; tabs: CodeTab[] };

function parseDocBlocks(markdown: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  let cursor = 0;
  const sectionOpen = /<!--\s*@section\s*-->/g;
  const sectionClose = /<!--\s*@\/section\s*-->/g;
  const exampleOpen = /<!--\s*@example\s*-->/;
  const exampleClose = /<!--\s*@\/example\s*-->/;

  let openMatch = sectionOpen.exec(markdown);

  if (!openMatch) {
    return [{ type: 'markdown', content: markdown }];
  }

  while (openMatch) {
    // Plain markdown before this section.
    const before = markdown.slice(cursor, openMatch.index).trim();
    if (before) {
      blocks.push({ type: 'markdown', content: before });
    }

    const afterOpen = openMatch.index + openMatch[0].length;

    // Find matching close.
    sectionClose.lastIndex = afterOpen;
    const closeMatch = sectionClose.exec(markdown);

    let sectionBody: string;
    if (closeMatch) {
      sectionBody = markdown.slice(afterOpen, closeMatch.index);
      cursor = closeMatch.index + closeMatch[0].length;
    } else {
      // No close — rest of file is this section.
      sectionBody = markdown.slice(afterOpen);
      cursor = markdown.length;
    }

    // Extract example from `<!-- @example -->` … `<!-- @/example -->`.
    const exampleOpenMatch = sectionBody.match(exampleOpen);
    if (exampleOpenMatch && exampleOpenMatch.index !== undefined) {
      const beforeExample = sectionBody.slice(0, exampleOpenMatch.index).trim();
      const afterExampleOpen = exampleOpenMatch.index + exampleOpenMatch[0].length;
      const exampleCloseMatch = sectionBody.slice(afterExampleOpen).match(exampleClose);

      let exampleBody: string;
      let afterExample: string;
      if (exampleCloseMatch && exampleCloseMatch.index !== undefined) {
        exampleBody = sectionBody.slice(afterExampleOpen, afterExampleOpen + exampleCloseMatch.index).trim();
        afterExample = sectionBody.slice(afterExampleOpen + exampleCloseMatch.index + exampleCloseMatch[0].length).trim();
      } else {
        // No close tag — rest of section is the example.
        exampleBody = sectionBody.slice(afterExampleOpen).trim();
        afterExample = '';
      }

      const contentParts = [beforeExample, afterExample].filter(Boolean).join('\n\n');
      blocks.push({
        type: 'tabbed',
        content: contentParts,
        example: exampleBody,
      });
    } else {
      // No @example marker — entire section is content-only, still tabbed.
      blocks.push({ type: 'tabbed', content: sectionBody.trim(), example: '' });
    }

    if (!closeMatch) break;

    sectionOpen.lastIndex = cursor;
    openMatch = sectionOpen.exec(markdown);
  }

  // Remaining text after the last section.
  if (cursor < markdown.length) {
    const remaining = markdown.slice(cursor).trim();
    if (remaining) {
      blocks.push({ type: 'markdown', content: remaining });
    }
  }

  return blocks;
}

function getSafeHref(href?: string) {
  if (!href) return undefined;

  const isSafe = href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:');

  return isSafe ? href : undefined;
}

const markdownComponents = {
  h1: ({ children }: NodeProps) => <h4 className="mt-4 text-lg font-bold">{children}</h4>,
  h2: ({ children }: NodeProps) => <h4 className="mt-4 text-lg font-semibold">{children}</h4>,
  h3: ({ children }: NodeProps) => <h5 className="mt-2 text-base font-semibold">{children}</h5>,
  h4: ({ children }: NodeProps) => <h6 className="mt-2 text-sm font-medium">{children}</h6>,
  p: ({ children }: NodeProps) => <p className="text-sm leading-relaxed">{children}</p>,
  ul: ({ children }: NodeProps) => <ul className="list-disc space-y-1 pl-5 text-sm">{children}</ul>,
  ol: ({ children }: NodeProps) => <ol className="list-decimal space-y-1 pl-5 text-sm">{children}</ol>,
  li: ({ children }: NodeProps) => <li className="leading-relaxed">{children}</li>,
  code: ({ children, className }: { children?: ReactNode; className?: string }) => {
    if (className) {
      const text = String(children).replace(/\n$/, '');
      return <CodeBlock code={text} />;
    }
    return (
      <Badge variant="outline" className="rounded px-1 py-0 font-mono text-xs font-normal">
        {children}
      </Badge>
    );
  },
  pre: ({ children }: NodeProps) => {
    return <>{children}</>;
  },
  hr: () => <Separator className="mt-5.5 mb-3" />,
  blockquote: ({ children }: NodeProps) => (
    <Alert variant="default">
      <AlertDescription className="text-sm leading-relaxed">{children}</AlertDescription>
    </Alert>
  ),
  a: ({ href, children }: LinkNodeProps) => (
    <a href={getSafeHref(href)} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
      {children}
    </a>
  ),
  table: ({ children }: NodeProps) => (
    <div className="overflow-x-auto rounded-md border">
      <Table className="text-sm">{children}</Table>
    </div>
  ),
  thead: ({ children }: NodeProps) => <TableHeader>{children}</TableHeader>,
  tbody: ({ children }: NodeProps) => <TableBody>{children}</TableBody>,
  tr: ({ children }: NodeProps) => <TableRow>{children}</TableRow>,
  th: ({ children }: NodeProps) => <TableHead className="text-sm font-semibold">{children}</TableHead>,
  td: ({ children }: NodeProps) => <TableCell className="text-sm">{children}</TableCell>,
} as const;

const markdownRenderOptions = {
  remarkPlugins: [remarkGfm],
  skipHtml: true,
  components: markdownComponents,
};

function preprocessTabGroups(markdown: string): MarkdownSegment[] {
  if (!markdown.includes(':::tabs')) {
    return [{ type: 'markdown', content: markdown }];
  }

  const segments: MarkdownSegment[] = [];
  let cursor = 0;
  const tabsOpen = /^:::tabs\s*$/gm;
  const tabsClose = /^:::\s*$/m;
  const fencedBlock = /```(\S+)\n([\s\S]*?)```/g;

  let openMatch = tabsOpen.exec(markdown);

  while (openMatch) {
    const before = markdown.slice(cursor, openMatch.index).trim();
    if (before) {
      segments.push({ type: 'markdown', content: before });
    }

    const afterOpen = openMatch.index + openMatch[0].length;
    const closeMatch = markdown.slice(afterOpen).match(tabsClose);

    let groupBody: string;
    if (closeMatch && closeMatch.index !== undefined) {
      groupBody = markdown.slice(afterOpen, afterOpen + closeMatch.index);
      cursor = afterOpen + closeMatch.index + closeMatch[0].length;
    } else {
      groupBody = markdown.slice(afterOpen);
      cursor = markdown.length;
    }

    // Extract fenced code blocks from the group body.
    const tabs = Array.from(groupBody.matchAll(fencedBlock), (match) => ({
      label: match[1],
      code: match[2].trimEnd(),
    }));

    if (tabs.length > 0) {
      segments.push({ type: 'code-tabs', tabs });
    }

    tabsOpen.lastIndex = cursor;
    openMatch = tabsOpen.exec(markdown);
  }

  if (cursor < markdown.length) {
    const remaining = markdown.slice(cursor).trim();
    if (remaining) {
      segments.push({ type: 'markdown', content: remaining });
    }
  }

  return segments;
}

function TabbedCodeGroup({ tabs }: { tabs: CodeTab[] }) {
  const defaultTab = tabs[0]?.label;
  if (!defaultTab) {
    return null;
  }

  return (
    <Tabs defaultValue={defaultTab}>
      <TabsList>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.label} value={tab.label}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.label} value={tab.label} className="mt-3">
          <CodeBlock code={tab.code} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

function MarkdownSection({ content }: { content: string }) {
  const segments = preprocessTabGroups(content);

  const renderMarkdown = (segmentContent: string, key?: number) => (
    <ReactMarkdown key={key} {...markdownRenderOptions}>
      {segmentContent}
    </ReactMarkdown>
  );

  if (segments.length === 1 && segments[0].type === 'markdown') {
    return <div className="space-y-3">{renderMarkdown(segments[0].content)}</div>;
  }

  return (
    <div className="space-y-3">
      {segments.map((segment, index) =>
        segment.type === 'code-tabs' ? <TabbedCodeGroup key={index} tabs={segment.tabs} /> : renderMarkdown(segment.content, index),
      )}
    </div>
  );
}

function TabbedSection({ content, example }: { content: string; example: string }) {
  return (
    <Tabs defaultValue="section" className="gap-0">
      <TabsList variant="line" className="h-8">
        <TabsTrigger value="section" className="px-3 py-1 text-sm">
          Section
        </TabsTrigger>
        <TabsTrigger value="example" className="px-3 py-1 text-sm">
          Example
        </TabsTrigger>
      </TabsList>

      <TabsContent value="section" className="mt-3">
        {content ? <MarkdownSection content={content} /> : null}
      </TabsContent>

      <TabsContent value="example" className="mt-3">
        {example ? <MarkdownSection content={example} /> : <p className="text-muted-foreground text-sm">No example provided.</p>}
      </TabsContent>
    </Tabs>
  );
}

export function DocContent({ content }: DocContentProps) {
  const blocks = parseDocBlocks(content);

  // Single plain-markdown block — no wrapper needed.
  if (blocks.length === 1 && blocks[0].type === 'markdown') {
    return <MarkdownSection content={blocks[0].content} />;
  }

  return (
    <div className="space-y-3">
      {blocks.map((block, index) =>
        block.type === 'markdown' ? (
          <MarkdownSection key={index} content={block.content} />
        ) : (
          <TabbedSection key={index} content={block.content} example={block.example} />
        ),
      )}
    </div>
  );
}
