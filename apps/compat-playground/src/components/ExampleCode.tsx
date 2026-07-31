import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CodeExample, Skeleton } from '@arcaai/ui';

// TASK-586 Lane I item 4 — "the ACTUAL source used, exactly what was used".
// Loaded LAZILY via `import.meta.glob` (dynamic, not a static `?raw` import):
// several of these files are part of the running app's own module graph, and a
// static `?raw` import of them (e.g. App.tsx, which imports this component)
// would create a real file-level cycle that breaks Vite's dev-time HMR graph.
// The dynamic `import()` boundary `import.meta.glob` compiles to sidesteps that.
const EXAMPLE_SOURCE_FILES: Array<{ path: string; title: string; language: string }> = [
  { path: '/src/App.tsx', title: 'App.tsx (tabs + 3-column layout + provider wiring)', language: 'tsx' },
  { path: '/src/components/ConfigColumn.tsx', title: 'components/ConfigColumn.tsx (column 1 — config + connect)', language: 'tsx' },
  {
    path: '/src/components/SessionWorkspace.tsx',
    title: 'components/SessionWorkspace.tsx (session state; renders cols 2 + 3)',
    language: 'tsx',
  },
  { path: '/src/components/ControllerColumn.tsx', title: 'components/ControllerColumn.tsx (column 2 — controls)', language: 'tsx' },
  { path: '/src/components/TranscriptColumn.tsx', title: 'components/TranscriptColumn.tsx (column 3 — timeline)', language: 'tsx' },
  { path: '/src/components/ProviderToggle.tsx', title: 'components/ProviderToggle.tsx (ON/OFF engine toggle)', language: 'tsx' },
  { path: '/src/components/DisconnectedColumns.tsx', title: 'components/DisconnectedColumns.tsx (pre-connect placeholders)', language: 'tsx' },
  { path: '/src/lib/config-store.ts', title: 'lib/config-store.ts (config mapping + persistence)', language: 'ts' },
];

const RAW_SOURCE_LOADERS = import.meta.glob(
  [
    '/src/App.tsx',
    '/src/components/ConfigColumn.tsx',
    '/src/components/SessionWorkspace.tsx',
    '/src/components/ControllerColumn.tsx',
    '/src/components/TranscriptColumn.tsx',
    '/src/components/ProviderToggle.tsx',
    '/src/components/DisconnectedColumns.tsx',
    '/src/lib/config-store.ts',
  ],
  { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;

/**
 * Tab 2 — the actual source files this playground runs, loaded at runtime via
 * Vite `import.meta.glob`, not a paraphrase. Kept in sync automatically: the
 * glob reads whatever is on disk.
 */
export function ExampleCode() {
  const [sources, setSources] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all(EXAMPLE_SOURCE_FILES.map(({ path }) => RAW_SOURCE_LOADERS[path]?.() ?? Promise.resolve('')))
      .then((results) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        EXAMPLE_SOURCE_FILES.forEach(({ path }, i) => {
          map[path] = results[i] ?? '';
        });
        setSources(map);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load example source');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Example code</CardTitle>
        <CardDescription>
          Exactly the source this playground runs — read from disk at runtime via Vite{' '}
          <code className="font-mono text-xs">import.meta.glob(&hellip;, &#123; query: &apos;?raw&apos; &#125;)</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error ? (
          <p className="text-destructive text-sm">Failed to load example source: {error}</p>
        ) : !sources ? (
          <div className="flex flex-col gap-2">
            {EXAMPLE_SOURCE_FILES.map(({ path }) => (
              <Skeleton key={path} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          // A visible filename heading per block — the shared `CodeExample`
          // trigger only reads "Show Example Code" while collapsed, so without
          // this the list of eight files is indistinguishable until expanded.
          EXAMPLE_SOURCE_FILES.map(({ path, title, language }, i) => (
            <div key={path} className="flex flex-col gap-1">
              <p className="text-sm font-medium">{title}</p>
              <CodeExample title={title} code={sources[path] ?? ''} language={language} defaultOpen={i === 0} />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
