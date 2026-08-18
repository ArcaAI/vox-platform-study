import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Label, Skeleton, Switch } from '@arcaai/ui';
import { useText, type SummaryResponse } from '@arcaai/vox/compat';
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
 * wired to the v1-compat SMR API through `useText()`. Orchestrator: owns every
 * piece of state and the two request handlers; `ContextForm`,
 * `TranscriptSource`, and the `SummaryResultView` family (
 * split, ~467 LOC → 4 files) are presentational.
 *
 * Pick a REAL tenant department (so the gateway resolver can match it to a
 * governed instruction template), add clinical context, pre-summarize, then
 * summarize the transcript with the pre-summary folded into context. R10:
 * the streaming toggle threads `{stream:true, onDelta}` through to the
 * already-shipped SDK/gateway SSE path — see `useText.ts` and
 * `smr-compat.controller.ts`.
 */
export function SummaryCard({ config }: SummaryCardProps) {
  const { preSummarize, summarizeSync, loading } = useText();

  // The live caption comes from the console-wide session context, NOT a prop:
  // this card lives in the Summarization tab while the transcript is produced
  // in the Live-transcription tab, and the two panels never see each other.
  const transcriptLines = usePlaygroundSession().transcript.lineTexts;
  // Batch-upload hand-off: a completed job's transcript pushed over
  // from the Batch-upload tab. Same cross-tab route as the live transcript —
  // through the console-wide session context, never a prop.
  const batchHandoff = usePlaygroundSession().batch.handoff;

  // Department + visit type (persisted). `visitType` is always the EFFECTIVE
  // value — a preset label or free text — never a sentinel; `ContextForm`
  // derives its own list-vs-custom UI state from it (fixes finding A4: no
  // separate "seeded but not in the preset list" fallback to reconcile).
  const [department, setDepartment] = useState(config.department ?? '');
  const [visitType, setVisitType] = useState(config.visitType?.trim() || DEFAULT_VISIT_TYPE);

  // Doctor whose DNA writing-style is applied (persisted). Empty ⇒ NO doctorId
  // is sent (department + visit-type only).
  const [doctorId, setDoctorId] = useState(config.doctorId ?? '');

  // Clinical context.
  const [context, setContext] = useState<ClinicalContextValues>(EMPTY_CONTEXT);
  const updateContext = <K extends keyof ClinicalContextValues>(key: K, value: ClinicalContextValues[K]) => {
    setContext((prev) => ({ ...prev, [key]: value }));
  };

  // Transcript source (R9): explicit selector instead of "non-empty paste wins".
  const [transcriptMode, setTranscriptMode] = useState<TranscriptSourceMode>('live');
  const [pastedTranscript, setPastedTranscript] = useState('');
  const [additionalContext, setAdditionalContext] = useState('');

  // Apply each hand-off EXACTLY ONCE, keyed on its token. Keying on the text
  // would re-apply on every render (and silently undo a manual edit); keying on
  // the token means a second "Send to Summarization" of the SAME transcript
  // still lands, while re-renders in between do nothing.
  const appliedHandoffRef = useRef(0);
  useEffect(() => {
    if (!batchHandoff || batchHandoff.token === appliedHandoffRef.current) return;
    appliedHandoffRef.current = batchHandoff.token;
    setPastedTranscript(batchHandoff.text);
    setTranscriptMode('pasted');
  }, [batchHandoff]);

  const [useEnhanced, setUseEnhanced] = useState(true);

  // Translate the transcript to English (Sarvam) before summarizing (persisted).
  const [translateToEnglish, setTranslateToEnglish] = useState(config.translateToEnglish ?? false);

  // Streaming toggle (R10).
  const [streamEnabled, setStreamEnabled] = useState(false);
  const [streamingPreSummary, setStreamingPreSummary] = useState('');
  const [streamingSummary, setStreamingSummary] = useState('');
  // Reasoning-model chain-of-thought (separate SSE channel). Kept AFTER the run
  // completes — reset only when the next request starts — so it stays visible
  // alongside the final answer, not wiped the instant the result arrives.
  const [reasoning, setReasoning] = useState('');

  // Raw JSON the model streamed for the SUMMARY (the accumulated deltas). Kept
  // after the run so the developer can still inspect the exact JSON that
  // produced the structured view below — the live preview is swapped out for
  // `SummaryView` on completion, which otherwise makes the raw output vanish.
  const [rawSummaryOutput, setRawSummaryOutput] = useState('');

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
    saveStoredConfig({ ...config, department: department.trim(), visitType: visitType.trim(), doctorId: doctorId.trim(), translateToEnglish });
  };

  const handlePreSummarize = async () => {
    setStreamingPreSummary('');
    setReasoning('');
    try {
      const res = await preSummarize({
        current_department: department.trim() || undefined,
        visit_type: visitType.trim() || undefined,
        doctorId: doctorId.trim() || undefined,
        age: context.age.trim() || undefined,
        dob: context.dob.trim() || undefined,
        gender: context.gender.trim() || undefined,
        formatted_vitals: context.vitals.trim() || undefined,
        formatted_test_results: context.testResults.trim() || undefined,
        formatted_previous_visits: context.previousVisits.trim() || undefined,
        language: config.languageMode?.startsWith('ml') ? 'ml' : 'en',
        ...(streamEnabled
          ? {
              stream: true,
              onDelta: (_delta: string, accumulated: string) => setStreamingPreSummary(accumulated),
              onReasoning: (_r: string, accumulated: string) => setReasoning(accumulated),
            }
          : {}),
      });
      setPreSummary(res.pre_summary);
      persistDefaults();
      toast.success('Pre-summary ready.');
    } catch (err) {
      // Covers both an SSE `error` frame (rejects with `data.detail`) and the
      // "stream ended without a result event" guard in `useText` — both throw a
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
    setReasoning('');
    setRawSummaryOutput('');
    try {
      const res = await summarizeSync({
        text: effectiveTranscript,
        departmentId: department.trim() || undefined,
        doctorId: doctorId.trim() || undefined,
        visitType: visitType.trim() || undefined,
        testResultsText: context.testResults.trim() || undefined,
        previousVisitsText: context.previousVisits.trim() || undefined,
        ...(preSummary ? { preSummaryText: preSummary, includePreSummaryInContext: true } : {}),
        useEnhancedFormat: useEnhanced,
        translateToEnglish,
        ...(streamEnabled
          ? {
              stream: true,
              onDelta: (_delta: string, accumulated: string) => {
                setStreamingSummary(accumulated);
                setRawSummaryOutput(accumulated);
              },
              onReasoning: (_r: string, accumulated: string) => setReasoning(accumulated),
            }
          : {}),
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
          Pre-summarize the clinical context, then summarize the transcript through <code className="font-mono text-xs">useText()</code> (the
          v1-compat API). Pick a real tenant department so the gateway can match a governed instruction template.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <ContextForm
          apiEndpoint={apiEndpoint}
          apiKey={apiKey}
          department={department}
          onDepartmentChange={setDepartment}
          doctorId={doctorId}
          onDoctorIdChange={setDoctorId}
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
          <div className="flex items-center gap-2">
            <Switch id="summary-translate" checked={translateToEnglish} onCheckedChange={setTranslateToEnglish} />
            <Label htmlFor="summary-translate">Translate transcript to English (Sarvam)</Label>
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

        {/* Reasoning-model chain-of-thought — its own collapsible channel, shown
            live while streaming AND kept beside the final answer. Only visible
            for reasoning models that emit a reasoning stream. */}
        {reasoning ? (
          <details className="rounded border" open={loading}>
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm font-semibold">
              Reasoning
              <Badge variant="secondary">AI</Badge>
              {loading && streamEnabled ? <Badge variant="outline">Streaming…</Badge> : null}
            </summary>
            <div className="text-muted-foreground max-h-72 overflow-auto px-3 pb-3 text-sm whitespace-pre-wrap" aria-live="polite">
              {reasoning}
            </div>
          </details>
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

        {/* Raw model output (JSON) — persisted after the run so the structured
            view above doesn't make the streamed JSON vanish. Dev-console aid. */}
        {rawSummaryOutput && !showSummaryStreamPreview ? (
          <details className="rounded border">
            <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">Raw model output (JSON)</summary>
            <pre className="text-muted-foreground max-h-72 overflow-auto px-3 pb-3 text-xs whitespace-pre-wrap">{rawSummaryOutput}</pre>
          </details>
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
