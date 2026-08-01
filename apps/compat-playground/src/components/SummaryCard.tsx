import { useMemo, useState } from 'react';
import { Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Label, Skeleton, Switch } from '@arcaai/ui';
import { useSMR, type SummaryResponse } from '@arcaai/vox/compat';
import { toast } from 'sonner';
import { saveStoredConfig, type PlaygroundConfig } from '../lib/config-store';
import { usePlaygroundSession } from '../context/playground-session';
import { ContextForm, DEFAULT_VISIT_TYPE, type ClinicalContextValues } from './summarization/ContextForm';
import { TranscriptSource, computeEffectiveTranscript, type TranscriptSourceMode } from './summarization/TranscriptSource';
import { StreamingPreview, SummaryView } from './summarization/SummaryResultView';

interface SummaryCardProps {
  config: PlaygroundConfig;
}

const EMPTY_CONTEXT: ClinicalContextValues = {
  age: '',
  dob: '',
  gender: '',
  vitals: '',
  testResults: '',
  previousVisits: '',
};

/**
 * The pre-summarization → summarization surface for the Summarization tab,
 * wired to the v1-compat SMR API through `useSMR()`. Orchestrator: owns every
 * piece of state and the two request handlers; `ContextForm`,
 * `TranscriptSource`, and the `SummaryResultView` family (TASK-597 lane F
 * split, ~467 LOC → 4 files) are presentational.
 *
 * Pick a REAL tenant department (so the gateway resolver can match it to a
 * governed instruction template), add clinical context, pre-summarize, then
 * summarize the transcript with the pre-summary folded into context. R10:
 * the streaming toggle threads `{stream:true, onDelta}` through to the
 * already-shipped SDK/gateway SSE path — see `useSMR.ts` and
 * `smr-compat.controller.ts`.
 */
export function SummaryCard({ config }: SummaryCardProps) {
  const { preSummarize, summarizeSync, loading } = useSMR();

  // The live caption comes from the console-wide session context, NOT a prop:
  // this card lives in the Summarization tab while the transcript is produced
  // in the Live-transcription tab, and the two panels never see each other.
  const transcriptLines = usePlaygroundSession().transcript.lineTexts;

  // Department + visit type (persisted). `visitType` is always the EFFECTIVE
  // value — a preset label or free text — never a sentinel; `ContextForm`
  // derives its own list-vs-custom UI state from it (fixes finding A4: no
  // separate "seeded but not in the preset list" fallback to reconcile).
  const [department, setDepartment] = useState(config.department ?? '');
  const [visitType, setVisitType] = useState(config.visitType?.trim() || DEFAULT_VISIT_TYPE);

  // Clinical context.
  const [context, setContext] = useState<ClinicalContextValues>(EMPTY_CONTEXT);
  const updateContext = <K extends keyof ClinicalContextValues>(key: K, value: ClinicalContextValues[K]) => {
    setContext((prev) => ({ ...prev, [key]: value }));
  };

  // Transcript source (R9): explicit selector instead of "non-empty paste wins".
  const [transcriptMode, setTranscriptMode] = useState<TranscriptSourceMode>('live');
  const [pastedTranscript, setPastedTranscript] = useState('');
  const [additionalContext, setAdditionalContext] = useState('');

  const [useEnhanced, setUseEnhanced] = useState(true);

  // Streaming toggle (R10).
  const [streamEnabled, setStreamEnabled] = useState(false);
  const [streamingPreSummary, setStreamingPreSummary] = useState('');
  const [streamingSummary, setStreamingSummary] = useState('');

  // Results.
  const [preSummary, setPreSummary] = useState<string | null>(null);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);

  const apiEndpoint = config.apiEndpoint;
  const apiKey = config.apiKey;

  const effectiveTranscript = useMemo(
    () => computeEffectiveTranscript(transcriptMode, transcriptLines, pastedTranscript, additionalContext),
    [transcriptMode, transcriptLines, pastedTranscript, additionalContext],
  );
  const hasTranscript = effectiveTranscript.trim().length > 0;

  const persistDefaults = () => {
    saveStoredConfig({ ...config, department: department.trim(), visitType: visitType.trim() });
  };

  const handlePreSummarize = async () => {
    setStreamingPreSummary('');
    try {
      const res = await preSummarize({
        current_department: department.trim() || undefined,
        visit_type: visitType.trim() || undefined,
        age: context.age.trim() || undefined,
        dob: context.dob.trim() || undefined,
        gender: context.gender.trim() || undefined,
        formatted_vitals: context.vitals.trim() || undefined,
        formatted_test_results: context.testResults.trim() || undefined,
        formatted_previous_visits: context.previousVisits.trim() || undefined,
        language: config.languageMode?.startsWith('ml') ? 'ml' : 'en',
        ...(streamEnabled ? { stream: true, onDelta: (_delta: string, accumulated: string) => setStreamingPreSummary(accumulated) } : {}),
      });
      setPreSummary(res.pre_summary);
      persistDefaults();
      toast.success('Pre-summary ready.');
    } catch (err) {
      // Covers both an SSE `error` frame (rejects with `data.detail`) and the
      // "stream ended without a result event" guard in `useSMR` — both throw a
      // plain `Error`, so this single catch surfaces either as a toast, never
      // a silent stall.
      toast.error(err instanceof Error ? err.message : 'Pre-summary failed');
    } finally {
      setStreamingPreSummary('');
    }
  };

  const handleSummarize = async () => {
    if (!hasTranscript) return;
    setStreamingSummary('');
    try {
      const res = await summarizeSync({
        text: effectiveTranscript,
        departmentId: department.trim() || undefined,
        visitType: visitType.trim() || undefined,
        testResultsText: context.testResults.trim() || undefined,
        previousVisitsText: context.previousVisits.trim() || undefined,
        ...(preSummary ? { preSummaryText: preSummary, includePreSummaryInContext: true } : {}),
        useEnhancedFormat: useEnhanced,
        ...(streamEnabled ? { stream: true, onDelta: (_delta: string, accumulated: string) => setStreamingSummary(accumulated) } : {}),
      });
      setSummary(res);
      persistDefaults();
      toast.success('Summary generated.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Summarization failed');
    } finally {
      setStreamingSummary('');
    }
  };

  // While a streaming request is in flight there is live text to show instead
  // of a bare skeleton; the skeleton is reserved for the non-streaming path
  // (or the gap before the first delta arrives).
  const showPreSummaryStreamPreview = loading && streamEnabled && streamingPreSummary !== '';
  const showSummaryStreamPreview = loading && streamEnabled && streamingSummary !== '';
  const showSkeleton = loading && !showPreSummaryStreamPreview && !showSummaryStreamPreview;

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>Summarization</CardTitle>
        <CardDescription>
          Pre-summarize the clinical context, then summarize the transcript through <code className="font-mono text-xs">useSMR()</code> (v1-compat SMR
          API). Pick a real tenant department so the gateway can match a governed instruction template.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <ContextForm
          apiEndpoint={apiEndpoint}
          apiKey={apiKey}
          department={department}
          onDepartmentChange={setDepartment}
          visitType={visitType}
          onVisitTypeChange={setVisitType}
          context={context}
          onContextChange={updateContext}
        />

        <TranscriptSource
          mode={transcriptMode}
          onModeChange={setTranscriptMode}
          liveLines={transcriptLines}
          pastedText={pastedTranscript}
          onPastedTextChange={setPastedTranscript}
          additionalContext={additionalContext}
          onAdditionalContextChange={setAdditionalContext}
        />

        {/* Format + streaming toggles */}
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-2">
            <Switch id="summary-enhanced" checked={useEnhanced} onCheckedChange={setUseEnhanced} />
            <Label htmlFor="summary-enhanced">Enhanced format</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="summary-stream" checked={streamEnabled} onCheckedChange={setStreamEnabled} />
            <Label htmlFor="summary-stream">Stream responses</Label>
          </div>
        </div>

        {/* Results */}
        {showSkeleton ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : null}

        {showPreSummaryStreamPreview ? <StreamingPreview label="Pre-summary" text={streamingPreSummary} /> : null}
        {showSummaryStreamPreview ? <StreamingPreview label="Summary" text={streamingSummary} /> : null}

        {preSummary ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">Pre-summary</h3>
              <Badge variant="secondary">AI</Badge>
            </div>
            <div className="bg-muted overflow-x-auto rounded p-3 text-sm whitespace-pre-wrap">{preSummary}</div>
          </div>
        ) : null}

        {summary ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">Summary</h3>
              <Badge variant="secondary">AI</Badge>
            </div>
            <SummaryView summary={summary} />
          </div>
        ) : null}
      </CardContent>

      <CardFooter className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={handlePreSummarize} disabled={loading}>
          Pre-summarize
        </Button>
        <Button onClick={handleSummarize} disabled={loading || !hasTranscript}>
          Summarize
        </Button>
        {!hasTranscript ? <span className="text-muted-foreground self-center text-xs">Record or paste a transcript to enable Summarize.</span> : null}
      </CardFooter>
    </Card>
  );
}
