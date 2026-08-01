import { useEffect, useState, type ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CodeExample, Skeleton } from '@arcaai/ui';

// =============================================================================
// Per-tab example code (TASK-597 R2, finding A1)
// =============================================================================
//
// Every tab ends with the REAL source of the files that tab is built from —
// read off disk at runtime via Vite's `import.meta.glob(…, { query: '?raw' })`.
// That is the whole point of the mechanism and the reason it survived the
// three-tab restructure unchanged: a hand-written snippet drifts the moment
// someone edits a component, this one cannot.
//
// It is LAZY (a dynamic `import()` boundary) rather than a static `?raw` import
// because several of these files are part of the running app's own module graph
// — `App.tsx` imports the tabs, which import this component — and a static raw
// import of them would create a real file-level cycle that breaks Vite's
// dev-time HMR graph.
//
// ⚠️ THE GLOB ARRAY BELOW IS STATICALLY ANALYSED BY VITE.
// It must contain a literal string for every path any tab lists. A path that is
// NOT in the array silently resolves to `undefined` (and previously, to an
// empty code block) — an invisible failure. Two guards exist:
//   1. `loadExampleSource` REJECTS on an unglobbed path instead of resolving
//      to `''`, so the UI shows an error rather than an empty block.
//   2. `__tests__/TabExampleCode.test.tsx` loads every file in every tab list
//      and asserts non-empty content. Add a file to a list without adding it
//      to the glob and that test fails.
//
// The array cannot be derived from the lists below — `import.meta.glob` needs
// literals — so the duplication is deliberate and the test is what keeps the
// two halves honest.
// =============================================================================

const RAW_SOURCE_LOADERS = import.meta.glob(
  [
    // Connection
    '/src/App.tsx',
    '/src/components/ConnectionTab.tsx',
    '/src/components/PipelinePicker.tsx',
    '/src/lib/pipelines.ts',
    '/src/lib/config-store.ts',
    // Live transcription
    '/src/context/playground-session.tsx',
    '/src/components/LiveTranscriptionTab.tsx',
    '/src/components/AudioSourcePanel.tsx',
    '/src/hooks/use-audio-sources.ts',
    '/src/lib/file-audio-source.ts',
    '/src/components/ControllerColumn.tsx',
    '/src/components/ProviderToggle.tsx',
    '/src/components/MetadataSimulator.tsx',
    '/src/components/TranscriptColumn.tsx',
    '/src/components/ScorecardPanel.tsx',
    '/src/lib/scoring.ts',
    // Summarization
    '/src/components/SummarizationTab.tsx',
    '/src/components/SummaryCard.tsx',
    '/src/components/summarization/ContextForm.tsx',
    '/src/components/summarization/TranscriptSource.tsx',
    '/src/components/summarization/SummaryResultView.tsx',
    '/src/lib/departments.ts',
  ],
  { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;

export interface ExampleFile {
  /** Root-absolute path, exactly as spelled in the glob array above. */
  path: string;
  /** Filename + one line on what it contributes to this tab. */
  title: string;
  language: 'ts' | 'tsx';
}

/** Tab 1 — credentials → `V1SdkConfig` → `<ArcaCompatProvider>`, plus the pipeline picker. */
export const CONNECTION_EXAMPLE_FILES: ExampleFile[] = [
  { path: '/src/App.tsx', title: 'App.tsx — three tabs, one provider mount, the connection gate', language: 'tsx' },
  { path: '/src/components/ConnectionTab.tsx', title: 'components/ConnectionTab.tsx — the credential form + Connect', language: 'tsx' },
  { path: '/src/components/PipelinePicker.tsx', title: 'components/PipelinePicker.tsx — real pipelines, free-text fallback', language: 'tsx' },
  { path: '/src/lib/pipelines.ts', title: 'lib/pipelines.ts — GET /api/v1/audio/pipelines with x-api-key', language: 'ts' },
  { path: '/src/lib/config-store.ts', title: 'lib/config-store.ts — config shape + localStorage persistence', language: 'ts' },
];

/** Tab 2 — the whole capture path: sources → mixer → STT → transcript → scoring. */
export const LIVE_TRANSCRIPTION_EXAMPLE_FILES: ExampleFile[] = [
  {
    path: '/src/context/playground-session.tsx',
    title: 'context/playground-session.tsx — the lifted session (session/capture/transcript/metadata/audio)',
    language: 'tsx',
  },
  { path: '/src/components/LiveTranscriptionTab.tsx', title: 'components/LiveTranscriptionTab.tsx — the tab layout', language: 'tsx' },
  { path: '/src/components/AudioSourcePanel.tsx', title: 'components/AudioSourcePanel.tsx — mic / multi-mic / file source picker', language: 'tsx' },
  { path: '/src/hooks/use-audio-sources.ts', title: 'hooks/use-audio-sources.ts — device enumeration + resolved capture options', language: 'ts' },
  { path: '/src/lib/file-audio-source.ts', title: 'lib/file-audio-source.ts — decodeAudioData → MediaStream, per virtual mic', language: 'ts' },
  { path: '/src/components/ControllerColumn.tsx', title: 'components/ControllerColumn.tsx — language, engine, start/stop', language: 'tsx' },
  { path: '/src/components/ProviderToggle.tsx', title: 'components/ProviderToggle.tsx — pipeline ↔ tenant-default switch', language: 'tsx' },
  {
    path: '/src/components/MetadataSimulator.tsx',
    title: 'components/MetadataSimulator.tsx — per-mic {mic, speaker} rows + auto-tag',
    language: 'tsx',
  },
  {
    path: '/src/components/TranscriptColumn.tsx',
    title: 'components/TranscriptColumn.tsx — the two-track transcript/metadata timeline',
    language: 'tsx',
  },
  { path: '/src/components/ScorecardPanel.tsx', title: 'components/ScorecardPanel.tsx — reference transcript, WER/CER, run export', language: 'tsx' },
  { path: '/src/lib/scoring.ts', title: 'lib/scoring.ts — WER/CER, ported from mlen_scorecard.py', language: 'ts' },
];

/** Tab 3 — department/visit/context → pre-summary → summary, streaming or not. */
export const SUMMARIZATION_EXAMPLE_FILES: ExampleFile[] = [
  { path: '/src/components/SummarizationTab.tsx', title: 'components/SummarizationTab.tsx — the tab shell', language: 'tsx' },
  { path: '/src/components/SummaryCard.tsx', title: 'components/SummaryCard.tsx — useSMR() orchestration + streaming toggle', language: 'tsx' },
  {
    path: '/src/components/summarization/ContextForm.tsx',
    title: 'components/summarization/ContextForm.tsx — department, visit type, clinical context',
    language: 'tsx',
  },
  {
    path: '/src/components/summarization/TranscriptSource.tsx',
    title: 'components/summarization/TranscriptSource.tsx — live / pasted / live + extra',
    language: 'tsx',
  },
  {
    path: '/src/components/summarization/SummaryResultView.tsx',
    title: 'components/summarization/SummaryResultView.tsx — Enhanced / Simplified / SOAP renderers',
    language: 'tsx',
  },
  { path: '/src/lib/departments.ts', title: 'lib/departments.ts — GET /api/v1/admin/departments with x-api-key', language: 'ts' },
];

/**
 * Load one file's raw source.
 *
 * Rejects — rather than resolving to `''` — when the path is missing from the
 * glob array above, because an empty code block looks exactly like a file that
 * happens to be empty. See the header.
 */
export function loadExampleSource(path: string): Promise<string> {
  const loader = RAW_SOURCE_LOADERS[path];
  if (!loader) {
    return Promise.reject(
      new Error(`${path} is not in TabExampleCode's import.meta.glob array. Vite analyses that array statically — add the literal path there.`),
    );
  }
  return loader();
}

interface TabExampleCodeProps {
  files: ExampleFile[];
  /** Optional extra sentence about what this particular tab's files show. */
  description?: ReactNode;
}

/**
 * The example-code block rendered at the END of a tab — only that tab's files.
 */
export function TabExampleCode({ files, description }: TabExampleCodeProps) {
  const [sources, setSources] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSources(null);
    setError(null);
    Promise.all(files.map(({ path }) => loadExampleSource(path)))
      .then((results) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        files.forEach(({ path }, i) => {
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
  }, [files]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Example code — this tab</CardTitle>
        <CardDescription>
          {description ? <>{description} </> : null}
          Exactly the source these controls run, read from disk at runtime via Vite{' '}
          <code className="font-mono text-xs">import.meta.glob(&hellip;, &#123; query: &apos;?raw&apos; &#125;)</code> — never a paraphrase, so it
          cannot drift from what you just used.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error ? (
          <p className="text-destructive text-sm">Failed to load example source: {error}</p>
        ) : !sources ? (
          <div className="flex flex-col gap-2">
            {files.map(({ path }) => (
              <Skeleton key={path} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          // A visible filename heading per block — the shared `CodeExample`
          // trigger only reads "Show Example Code" while collapsed, so without
          // this the list of files is indistinguishable until expanded.
          files.map(({ path, title, language }, i) => (
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
