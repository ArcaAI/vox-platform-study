'use client';

import * as React from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { Download } from 'lucide-react';

import { buttonVariants } from '@/components/shadcn/button';
import { cn } from '@/lib/utils';

// Bundle the pdf.js worker as a code-split asset so the version always matches
// react-pdf's pinned pdfjs-dist (D3). This module is only ever loaded lazily
// (client-side) via the `PdfRenderer` `React.lazy` boundary, so it is SSR-safe.
// TASK-410 re-verified: still a hard error (TS1470) under the CJS dts target — retained.
// @ts-expect-error -- import.meta.url is the canonical bundled-worker pattern (Vite/webpack5);
// tsc rejects it under the package's CJS dts target (TS1470), but esbuild rewrites it for
// both the ESM and CJS bundles, so it resolves correctly at runtime.
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

export interface PdfDocumentProps {
  url: string;
  name?: string;
  width?: number;
}

function PdfLoading() {
  return (
    <div role="status" aria-label="Loading PDF" className="p-6 text-sm text-muted-foreground">
      Loading PDF…
    </div>
  );
}

function DownloadFallback({ url, name }: { url: string; name?: string }) {
  return (
    <div data-slot="timeline-pdf-fallback" className="flex items-center gap-3 rounded-md border bg-card p-3 text-sm">
      <span className="text-muted-foreground">This PDF couldn’t be displayed.</span>
      <a href={url} download className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))} aria-label={`Download ${name ?? 'PDF'}`}>
        <Download className="size-4" />
        Download
      </a>
    </div>
  );
}

export default function PdfDocument({ url, name, width = 640 }: PdfDocumentProps) {
  const [numPages, setNumPages] = React.useState(0);
  const [failed, setFailed] = React.useState(false);

  if (failed) return <DownloadFallback url={url} name={name} />;

  return (
    <div data-slot="timeline-pdf" className="max-h-[70vh] overflow-auto rounded-md border bg-muted/30">
      <Document
        file={url}
        onLoadSuccess={({ numPages: n }) => setNumPages(n)}
        onLoadError={() => setFailed(true)}
        loading={<PdfLoading />}
        error={<DownloadFallback url={url} name={name} />}
      >
        {Array.from({ length: numPages }, (_, i) => (
          <Page key={i} pageNumber={i + 1} width={width} renderTextLayer={false} renderAnnotationLayer={false} className="mx-auto mb-2 shadow-sm" />
        ))}
      </Document>
    </div>
  );
}
