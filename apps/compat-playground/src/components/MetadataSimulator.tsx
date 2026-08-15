import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CodeEditor,
  FieldError,
  Input,
  Label,
  Slider,
  Switch,
} from '@arcaai/ui';
import { usePlaygroundSession, type PlaygroundAutoTagMode, type PlaygroundCapturePhase } from '../context/playground-session';

/**
 * When metadata may be attached (deliberate `phase` choice).
 *
 * Metadata is replayed onto the NEXT `onTranscript`, and since lane B tail
 * finals keep arriving through the whole `stopping` window — the mic is off,
 * the transport is still draining. So `stopping` is a perfectly good moment to
 * tag the turn that is about to land, and gating on `isRecording` (false from
 * the Stop click) disabled the form exactly when the last lines were coming in.
 * `starting` stays disabled: there is no session to attach to yet.
 */
function canAttachMetadata(phase: PlaygroundCapturePhase): boolean {
  return phase === 'recording' || phase === 'stopping';
}

/**
 * The metadata simulator — the Live-transcription tab's `{"mic":"1","speaker":"1"}`
 * demo from the reference screenshot. Two independent surfaces, both driven by
 * `usePlaygroundSession().metadata` (extracted from `ControllerColumn`,
 * lane C):
 *
 * 1. The frozen single-shot "Simulate metadata" form — unchanged
 * behaviour, now with an inline 8 KB field error instead of a bare toast.
 * 2. Per-mic rows (R5): one `{mic, speaker, ...json}` row per configured
 * source, sent by hand OR auto-tagged from the LIVE PER-SOURCE input level
 * — the loudest mic above the threshold owns the turn (
 * follow-up #2). It falls back to a round-robin rotation only when the SDK
 * reports no per-source signal, and says which of the two is running.
 *
 * Both surfaces share the SAME honesty note: on the v2 wire this metadata
 * never reaches the STT socket (see the callout below) — stated plainly here,
 * not buried in the README, because this app is what a migrating developer
 * reads to decide how metadata attribution actually works.
 */
export function MetadataSimulator() {
  return (
    <>
      <WireNote />
      <ManualMetadataCard />
      <MicRowsCard />
    </>
  );
}

/**
 * Findings S4/S5: both the v2 wire (this app) and the v1 compat wire attribute
 * metadata by recency, not per-frame correlation — only the transport differs.
 * Stated once, up front, so neither card below has to repeat it.
 */
function WireNote() {
  return (
    <div className="bg-muted/50 flex flex-col gap-1 rounded-md border p-3 text-xs">
      <p className="font-medium">This metadata never reaches the STT socket.</p>
      <p className="text-muted-foreground">
        The v2 gateway (<code className="font-mono">/ws/stt/stream</code>) accepts only{' '}
        <code className="font-mono">audio | stop | resume | close</code> — <code className="font-mono">sendAudioData</code> records metadata
        client-side and replays it onto the next transcript line by matching timestamps. The v1 compat gateway (
        <code className="font-mono">/stt</code>) does carry per-frame metadata on the wire, but its attribution is also last-wins / sticky, not
        per-frame correlated. <strong>Both paths are recency-attributed — only the transport differs.</strong>
      </p>
    </div>
  );
}

function ManualMetadataCard() {
  const { capture, metadata } = usePlaygroundSession();
  const disabled = !canAttachMetadata(capture.phase);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Simulate metadata</CardTitle>
        <CardDescription>
          <code className="font-mono text-xs">sendAudioData</code> tags the current turn; the same keys round-trip onto the next transcript line (see
          the live results).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="sim-speaker-id">speaker_id</Label>
            <Input
              id="sim-speaker-id"
              placeholder="doctor"
              value={metadata.speakerId}
              onChange={(e) => metadata.setSpeakerId(e.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sim-language">language</Label>
            <Input
              id="sim-language"
              placeholder="en"
              value={metadata.language}
              onChange={(e) => metadata.setLanguage(e.target.value)}
              disabled={disabled}
            />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="sim-metadata-json">Additional metadata (JSON object)</Label>
          <CodeEditor aria-label="Additional metadata JSON" value={metadata.json} onChange={metadata.setJson} language="json" className="h-28" />
          {metadata.sendError ? <FieldError>{metadata.sendError}</FieldError> : null}
        </div>
        <Button onClick={metadata.send} disabled={disabled} className="self-start">
          Send metadata
        </Button>
        {capture.phase === 'stopping' ? (
          <p className="text-muted-foreground text-xs">
            Still usable while finalizing — the mic is off but tail finals are still arriving, and this tags the next one.
          </p>
        ) : disabled ? (
          <p className="text-muted-foreground text-xs">Metadata can only be attached to a live turn — start recording first.</p>
        ) : null}
        {metadata.lastSent ? (
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs font-medium">Last sent</p>
            <pre className="bg-muted mt-1 overflow-x-auto rounded p-2 font-mono text-xs">{JSON.stringify(metadata.lastSent, null, 2)}</pre>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * What auto-tag can HONESTLY claim, in the mode it is actually running in.
 *
 * The three cases are three different guarantees, so they get three different
 * sentences rather than one hedged paragraph. `per-source` is real attribution
 * and says so; the other two name exactly what they cannot do. The mode is
 * derived from the live SDK signal (`audio.sourceLevels`), so this can never
 * drift from behaviour the way a hard-coded disclaimer did.
 */
function AutoTagModeNote({ mode, sourceCount }: { mode: PlaygroundAutoTagMode; sourceCount: number }) {
  if (mode === 'per-source') {
    return (
      <p className="text-muted-foreground text-xs">
        <strong className="text-foreground">Per-mic attribution is live.</strong> {sourceCount} per-source meters are being sampled inside the mixer
        (one analysis-only <code className="font-mono">AnalyserNode</code> per source), and the <em>loudest</em> source above the threshold owns the
        turn — a change of loudest mic re-tags immediately instead of waiting for silence. Caveat worth knowing: mics in one room bleed into each
        other, so this attributes by loudest <em>input</em>, not by voice identity.
      </p>
    );
  }
  if (mode === 'single-source') {
    return (
      <p className="text-muted-foreground text-xs">
        <strong className="text-foreground">One audio source</strong>, so every turn is tagged to it. That is exact for &ldquo;which input&rdquo; and
        says nothing about <em>which person</em> — a single microphone cannot separate two speakers. Select a second mic (or a multi-file /
        split-stereo source) to get real attribution.
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-xs">
      <strong className="text-foreground">No per-source level available</strong> (nothing is recording yet, or this runtime has no Web Audio
      analysis). Auto-tag falls back to rotating <em>round-robin</em> through the rows on the single mixed meter — that demonstrates the payload
      shape, it is <em>not</em> attribution.
    </p>
  );
}

function MicRowsCard() {
  const { audio, capture, metadata } = usePlaygroundSession();
  const disabled = !canAttachMetadata(capture.phase);
  // Auto-tag is the one control here that genuinely needs a LIVE mic: it fires
  // off the input-level meter, and there is no level once the mic is released.
  // So it gates on `recording` alone while the send buttons above accept
  // `stopping` too.
  const autoTagDisabled = capture.phase !== 'recording';
  // Defensive: lane A's `audio` group ships an ordered `sources` list, but this
  // group never depends on it existing — `rows` is self-sufficient either way.
  const sources = audio?.sources ?? [];
  const levels = audio?.sourceLevels ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          Per-mic metadata rows
          {metadata.autoTagEnabled ? (
            <Badge variant={metadata.autoTagMode === 'per-source' ? 'default' : 'secondary'}>
              Auto-tag on · {metadata.autoTagMode === 'unavailable' ? 'round-robin' : metadata.autoTagMode}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          One <code className="font-mono text-xs">{'{mic, speaker}'}</code> row per mic — the screenshot&apos;s tagging shape. Send a row by hand, or
          flip Auto-tag to emit automatically from the live per-source input level: the loudest mic above the threshold owns the turn, debounced to
          one emit per utterance.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {sources.length > 0 ? (
          <div className="flex flex-col gap-2 rounded-md border p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted-foreground">
                {sources.length} configured audio source{sources.length === 1 ? '' : 's'}.
              </span>
              <Button size="sm" variant="outline" onClick={() => metadata.syncRowsFromSources(sources)}>
                Sync rows from audio sources
              </Button>
            </div>
            {/* Live per-source level, index-aligned with `sources`. Shown as a
                number as well as a bar: a bar alone conveys the reading by
                length only, and this is the evidence for which row auto-tag
                just picked. */}
            <ul className="flex flex-col gap-1">
              {sources.map((source, index) => {
                const level = levels[index];
                return (
                  <li key={source.id} className="flex items-center gap-2">
                    <span className="w-14 shrink-0 font-mono">{source.micLabel}</span>
                    <span className="text-muted-foreground min-w-0 flex-1 truncate">{source.sourceLabel}</span>
                    {typeof level === 'number' ? (
                      <>
                        <span className="bg-muted h-1.5 w-24 shrink-0 overflow-hidden rounded-full">
                          <span className="bg-primary block h-full" style={{ width: `${Math.min(100, Math.max(0, level))}%` }} />
                        </span>
                        <span className="w-8 shrink-0 text-right font-mono" aria-label={`${source.micLabel} input level`}>
                          {level}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground shrink-0">no level</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">No configured audio sources yet — manage rows manually below (mic 1, mic 2, …).</p>
        )}

        <div className="flex flex-col gap-3 rounded-md border p-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Switch
                id="auto-tag-switch"
                checked={metadata.autoTagEnabled}
                onCheckedChange={metadata.setAutoTagEnabled}
                disabled={autoTagDisabled}
                aria-label="Auto-tag metadata rows on input level"
              />
              <Label htmlFor="auto-tag-switch">Auto-tag on level</Label>
            </div>
            <span className="text-muted-foreground font-mono text-xs">threshold {metadata.autoTagThreshold}</span>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="auto-tag-threshold">Level threshold (0–100)</Label>
            <Slider
              id="auto-tag-threshold"
              value={[metadata.autoTagThreshold]}
              onValueChange={([v]) => metadata.setAutoTagThreshold(v)}
              min={0}
              max={100}
              step={1}
              disabled={autoTagDisabled || !metadata.autoTagEnabled}
              aria-label="Auto-tag input level threshold"
            />
          </div>
          <AutoTagModeNote mode={metadata.autoTagMode} sourceCount={levels.length} />
          {autoTagDisabled ? (
            <p className="text-muted-foreground text-xs">Auto-tag only runs while recording — it reads the live input level.</p>
          ) : null}
        </div>

        <ul className="flex flex-col gap-3">
          {metadata.rows.map((row, index) => (
            <li key={row.id} className="flex flex-col gap-2 rounded-md border p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`mic-row-${row.id}-mic`}>mic</Label>
                  <Input
                    id={`mic-row-${row.id}-mic`}
                    value={row.mic}
                    onChange={(e) => metadata.updateRow(row.id, { mic: e.target.value })}
                    disabled={disabled}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`mic-row-${row.id}-speaker`}>speaker</Label>
                  <Input
                    id={`mic-row-${row.id}-speaker`}
                    value={row.speaker}
                    onChange={(e) => metadata.updateRow(row.id, { speaker: e.target.value })}
                    disabled={disabled}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`mic-row-${row.id}-json`}>Additional metadata (JSON object)</Label>
                <CodeEditor
                  aria-label={`Additional metadata JSON for mic ${row.mic || String(index + 1)}`}
                  value={row.json}
                  onChange={(v) => metadata.updateRow(row.id, { json: v })}
                  language="json"
                  className="h-20"
                />
                {metadata.rowErrors[row.id] ? <FieldError>{metadata.rowErrors[row.id]}</FieldError> : null}
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => metadata.sendRow(row.id)} disabled={disabled}>
                  Send
                </Button>
                <Button size="sm" variant="outline" onClick={() => metadata.removeRow(row.id)} disabled={metadata.rows.length <= 1}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <Button variant="outline" onClick={metadata.addRow} className="self-start">
          Add mic row
        </Button>
      </CardContent>
    </Card>
  );
}
