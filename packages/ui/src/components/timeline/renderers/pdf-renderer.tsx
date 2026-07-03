'use client';

import * as React from 'react';
import { Download } from 'lucide-react';

import { buttonVariants } from '@/components/shadcn/button';
import { cn } from '@/lib/utils';

import type { TimelineRendererProps } from '../types';
import type { PdfDocumentProps } from './pdf-document';

// react-pdf + pdf.js are heavy and browser-only — keep them out of the main
// bundle. The chunk only loads once an item is expanded (D3).
// NodeNext (dts build) requires an explicit extension on relative dynamic imports;
// esbuild rewrites `.js` → `.tsx` for the JS bundle. The `as unknown as …` keeps the
// dts (CJS-interop) view of the default export aligned with esbuild's ESM runtime shape.
// TASK-410 re-verified (tsc 5.9): dropping the extension → TS2835; dropping the cast →
// TS2322 (CJS interop wraps the module namespace as `default`) — still required.
const LazyPdfDocument = React.lazy(() => import('./pdf-document.js') as unknown as Promise<{ default: React.ComponentType<PdfDocumentProps> }>);

interface PdfErrorBoundaryProps {
  url: string;
  name?: string;
  children: React.ReactNode;
}

class PdfErrorBoundary extends React.Component<PdfErrorBoundaryProps, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div data-slot="timeline-pdf-fallback" className="flex items-center gap-3 rounded-md border bg-card p-3 text-sm">
          <span className="text-muted-foreground">This PDF couldn’t be displayed.</span>
          <a
            href={this.props.url}
            download
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
            aria-label={`Download ${this.props.name ?? 'PDF'}`}
          >
            <Download className="size-4" />
            Download
          </a>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * PDF content renderer (D3). Only mounts the lazy viewer once the item is
 * expanded; renders a download fallback if the chunk or document fails to load.
 */
export function PdfRenderer({ content, expanded }: TimelineRendererProps) {
  if (content.type !== 'pdf') return null;
  // Lazy: the heavy viewer is not mounted until the timeline item expands.
  if (!expanded) return null;
  return (
    <PdfErrorBoundary url={content.url} name={content.name}>
      <React.Suspense
        fallback={
          <div role="status" aria-label="Loading PDF" className="p-6 text-sm text-muted-foreground">
            Loading PDF…
          </div>
        }
      >
        <LazyPdfDocument url={content.url} name={content.name} />
      </React.Suspense>
    </PdfErrorBoundary>
  );
}
