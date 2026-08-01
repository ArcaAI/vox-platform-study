import { useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Skeleton, Textarea } from '@arcaai/ui';
import { toast } from 'sonner';
import { usePlaygroundSession, type PlaygroundAudioSlice } from '../context/playground-session';
import { buildRunExport, formatRate, parseReferenceText, REFERENCE_FILE_ACCEPT, scoreTranscript, type AlignmentOp } from '../lib/scoring';

/**
 * WER/CER scorecard for the Live-transcription tab (TASK-597 lane D, R6).
 *
 * Paste or upload a reference transcript and the streamed hypothesis is scored
 * against it live, so a pipeline or provider switch can be judged on numbers
 * instead of vibes. The metrics come from `../lib/scoring`, whose normalization
 * and CER are a behavioural port of `apps/stt/scripts/mlen_scorecard.py` — the
 * same code the TASK-594 Malayalam-English quality gate runs. That is the whole
 * point: a CER shown here and a CER in the regression baseline mean the same
 * thing.
 *
 * State is deliberately LOCAL to this panel. The reference transcript is a
 * scoring input, not session state, and keeping it here means the panel can be
 * dropped into (or out of) the tab without touching the shared session context.
 */

/** Per-op presentation: colour AND a text marker — never colour alone (§11). */
const OP_STYLES: Record<AlignmentOp['kind'], { marker: string; className: string; label: string }> = {
  equal: { marker: '=', className: 'text-foreground', label: 'match' },
  substitution: { marker: '~', className: 'bg-warning text-warning-foreground rounded px-1', label: 'substitution' },
  insertion: { marker: '+', className: 'bg-info text-info-foreground rounded px-1', label: 'insertion' },
  deletion: { marker: '−', className: 'bg-destructive text-destructive-foreground rounded px-1 line-through', label: 'deletion' },
};

function AlignedDiff({ alignment }: { alignment: AlignmentOp[] }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-sm leading-relaxed" data-testid="scorecard-diff">
      {alignment.map((op, index) => {
        const style = OP_STYLES[op.kind];
        if (op.kind === 'equal') {
          return (
            <span key={index} className={style.className}>
              {op.reference}
            </span>
          );
        }
        const shown = op.kind === 'substitution' ? `${op.reference} → ${op.hypothesis}` : (op.reference ?? op.hypothesis);
        return (
          <span key={index} className={style.className}>
            {/* The marker carries the meaning for anyone who cannot see the
                colour; the sr-only word spells it out for screen readers. */}
            <span aria-hidden="true">{style.marker} </span>
            <span className="sr-only">{style.label}: </span>
            {shown}
          </span>
        );
      })}
    </p>
  );
}

function DiffLegend() {
  return (
    <div className="flex flex-wrap gap-2">
      {(Object.keys(OP_STYLES) as AlignmentOp['kind'][])
        .filter((kind) => kind !== 'equal')
        .map((kind) => (
          <Badge key={kind} variant="outline" className="font-mono">
            <span aria-hidden="true">{OP_STYLES[kind].marker}</span> {OP_STYLES[kind].label}
          </Badge>
        ))}
    </div>
  );
}

/**
 * Human description of what the run was fed from, for the JSON export's
 * `run.audioSource` (TASK-597 lane G — lane D left this `null` because lane A's
 * `audio` context group did not exist yet).
 *
 * Shape: `"<mode> — mic 1: Built-in Microphone + mic 2: clip-b.wav @0.60×"`.
 * Gain is only spelled out when it is off unity, so the common case stays
 * readable. Returns `null` — not a guess — when there is genuinely nothing to
 * describe: a file mode with no file loaded has no source, and a mic mode with
 * no explicit selection is whatever the OS calls default, which the browser
 * will not tell us.
 */
export function describeAudioSource(audio: Pick<PlaygroundAudioSlice, 'mode' | 'sources'>): string | null {
  if (audio.sources.length === 0) {
    const isFileMode = audio.mode === 'file-single' || audio.mode === 'file-multi';
    return isFileMode ? null : `${audio.mode} — system default microphone`;
  }
  const parts = audio.sources.map((source) => `${source.micLabel}: ${source.sourceLabel}${source.gain === 1 ? '' : ` @${source.gain.toFixed(2)}×`}`);
  return `${audio.mode} — ${parts.join(' + ')}`;
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</span>
      <span className="font-mono text-2xl">{value}</span>
      {hint ? <span className="text-muted-foreground text-xs">{hint}</span> : null}
    </div>
  );
}

export function ScorecardPanel() {
  const { audio, config, session, transcript, language } = usePlaygroundSession();
  const [reference, setReference] = useState('');
  const [referenceSource, setReferenceSource] = useState('pasted');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The hypothesis is the live transcript, joined the way a consumer would read
  // it back. `lineTexts` is the memoized text-only projection from the session
  // context, so this does not re-run on every interim update.
  const hypothesis = useMemo(() => transcript.lineTexts.join(' '), [transcript.lineTexts]);

  const hasReference = reference.trim() !== '';
  const score = useMemo(() => (hasReference ? scoreTranscript(reference, hypothesis) : null), [hasReference, reference, hypothesis]);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = parseReferenceText(await file.text(), file.name);
      if (text.trim() === '') {
        toast.error(`${file.name} contained no readable transcript text.`);
        return;
      }
      setReference(text);
      setReferenceSource(file.name);
      toast.success(`Reference loaded from ${file.name}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not read the reference file');
    } finally {
      // Allow re-selecting the same file after an edit.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleExport = () => {
    if (!hasReference) return;
    const payload = buildRunExport(reference, hypothesis, {
      pipelineId: config.pipelineId.trim() || null,
      languageMode: language.mode,
      sessionId: session.id ?? null,
      // What this run was actually fed from, straight off lane A's `audio`
      // group — without it two exports from different mics or different clips
      // are indistinguishable, which defeats the point of exporting at all.
      audioSource: describeAudioSource(audio),
      referenceSource,
    });
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `scorecard-${payload.generatedAt.replace(/[:.]/g, '-')}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success('Scorecard run exported.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reference scoring (WER / CER)</CardTitle>
        <CardDescription>
          Paste or upload the ground-truth transcript for this clip and the live hypothesis is scored against it. Normalization and CER are ported
          from <code className="font-mono text-xs">apps/stt/scripts/mlen_scorecard.py</code>, so these numbers match the TASK-594 Malayalam-English
          quality gate. Case and punctuation are significant; text is NFC-normalized and whitespace-collapsed only.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="scorecard-reference">Reference transcript</Label>
          <Textarea
            id="scorecard-reference"
            className="h-32 font-mono text-sm"
            placeholder="Paste the ground-truth transcript here, or upload a .txt / .srt / .vtt file."
            value={reference}
            onChange={(event) => {
              setReference(event.target.value);
              setReferenceSource('pasted');
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="scorecard-reference-file" className="sr-only">
              Upload a reference transcript file
            </Label>
            <input
              ref={fileInputRef}
              id="scorecard-reference-file"
              type="file"
              accept={REFERENCE_FILE_ACCEPT}
              onChange={(event) => void handleFile(event.target.files?.[0])}
              className="text-muted-foreground file:text-foreground file:border-input file:bg-background hover:file:bg-accent max-w-full text-sm file:mr-3 file:cursor-pointer file:rounded-md file:border file:px-3 file:py-1.5 file:text-sm"
            />
            <Button variant="outline" size="sm" onClick={handleExport} disabled={!hasReference}>
              Export run (JSON)
            </Button>
            {hasReference ? <Badge variant="secondary">source: {referenceSource}</Badge> : null}
          </div>
          {!hasReference ? (
            <p className="text-muted-foreground text-xs">
              Scores appear once a reference is supplied. `.srt` / `.vtt` uploads are stripped down to spoken text (indices, timecodes and cue tags
              removed).
            </p>
          ) : null}
        </div>

        {hasReference && score ? (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Metric label="WER" value={formatRate(score.wer)} hint={`${score.referenceWords} ref words`} />
              <Metric label="CER" value={formatRate(score.cer)} hint={`${score.referenceCharacters} ref chars`} />
              <Metric label="S / I / D" value={`${score.substitutions}/${score.insertions}/${score.deletions}`} hint="sub / ins / del" />
              <Metric label="Hits" value={String(score.hits)} hint={`${score.hypothesisWords} hyp words`} />
            </div>

            {session.isPreSession ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            ) : hypothesis.trim() === '' ? (
              <p className="text-muted-foreground text-sm">
                No hypothesis yet — the reference is loaded and every word counts as a deletion until the transcript starts arriving.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                <DiffLegend />
                <div className="max-h-64 overflow-y-auto">
                  <AlignedDiff alignment={score.alignment} />
                </div>
              </div>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
