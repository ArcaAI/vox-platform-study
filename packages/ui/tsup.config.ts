import { defineConfig } from 'tsup';

export default defineConfig({
  // `src/index.ts` is the root barrel. `src/components/shared/index.ts` is shipped
  // as a dedicated subpath entry so `@arcaai/ui/components/shared` (StatusBadge /
  // StatusColorRole — intentionally kept off the root barrel) ships a matching
  // `dist/components/shared/index.d.ts` for type-only consumers like apps/admin.
  entry: ['src/index.ts', 'src/components/shared/index.ts', 'src/components/metrics/index.ts', 'src/components/workflow-canvas/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // react-pdf + pdfjs-dist are browser-only and heavy; keep them external so the
  // consuming app's bundler resolves the pdf.js worker asset (D3). They are runtime
  // deps of @arcaai/ui.
  external: ['react', 'react-dom', 'react-hook-form', 'react-pdf', 'pdfjs-dist'],
  treeshake: true,
  // MUST stay true. `PdfRenderer` pulls in `pdf-document.tsx` — which statically imports
  // react-pdf → pdf.js, whose module init touches the browser-only `DOMMatrix` — via
  // `React.lazy(() => import('./pdf-document.js'))`. With splitting:false, esbuild inlines
  // that dynamic import into the root barrel and hoists the `react-pdf` import to the top
  // of `index.mjs`, so it evaluates eagerly and crashes SSR ("DOMMatrix is not defined").
  // splitting:true keeps pdf-document (and react-pdf) in a lazy chunk, off the SSR path.
  splitting: true,
  // esbuild honours this banner — and then `treeshake: true` above throws it away. tsup's
  // tree-shaking plugin runs every emitted chunk back through rollup, whose `generate()` call
  // carries no banner of its own, and rollup drops a top-level string-literal statement as
  // side-effect-free. Measured on tsup 8.5.1: 0 of the emitted js/mjs files kept the directive
  // with treeshake on; all of them kept it with treeshake off.
  //
  // So this line alone is NOT what makes `dist/` safe to import from a Server Component —
  // `scripts/ensure-use-client.mjs`, which the `build` script runs after tsup, is. It is kept
  // because it is still the correct declaration of intent, and it becomes load-bearing again the
  // moment tree-shaking is turned off. Do not delete one without the other.
  esbuildOptions(options) {
    options.banner = {
      js: '"use client";',
    };
  },
});
