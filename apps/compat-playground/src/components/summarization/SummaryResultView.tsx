import { Badge } from '@arcaai/ui';
import type { EnhancedMedicalSummary, SimplifiedMedicalSummary, SoapMedicalSummary, MedicalSummary, SummaryResponse } from '@arcaai/vox/compat';

/**
 * Result rendering for the Summarization tab (TASK-597 lane F): the
 * Enhanced/Simplified/SOAP shape discriminators + renderers (moved verbatim
 * out of `SummaryCard.tsx`), plus `StreamingPreview` — the live-token view
 * shown while `stream:true` is in flight (R10). The SSE `delta` payload is the
 * RAW upstream generation text (see `apps/api/.../smr-compat.controller.ts`
 * `streamGenerate` — `chunk` frames become `event: delta`), not a partial
 * structured summary, so streaming can only preview accumulated text; the
 * structured `SummaryView` below takes over once the terminal `result` event
 * resolves the request with the same v1-shaped body the non-streaming path
 * returns.
 */

// =============================================================================
// Shape discriminators
// =============================================================================

export function isEnhanced(s: MedicalSummary): s is EnhancedMedicalSummary {
  return (s as Partial<EnhancedMedicalSummary>).encounter_summary !== undefined;
}
export function isSoap(s: MedicalSummary): s is SoapMedicalSummary {
  return (s as Partial<SoapMedicalSummary>).subjective !== undefined;
}

// =============================================================================
// Renderers
// =============================================================================

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-semibold">{title}</h4>
      <div className="text-muted-foreground text-sm">{children}</div>
    </div>
  );
}

function EnhancedView({ s }: { s: EnhancedMedicalSummary }) {
  const meds = s.treatment_plan.medications ?? [];
  return (
    <div className="flex flex-col gap-3">
      <Section title="Chief complaint">{s.encounter_summary.chief_complaint || '—'}</Section>
      <Section title="Primary diagnosis">
        {s.clinical_assessment.primary_diagnosis.diagnosis || '—'}
        {s.clinical_assessment.primary_diagnosis.icd10_code ? (
          <Badge variant="outline" className="ml-2">
            {s.clinical_assessment.primary_diagnosis.icd10_code}
          </Badge>
        ) : null}
      </Section>
      {meds.length > 0 ? (
        <Section title="Medications">
          <ul className="list-inside list-disc">
            {meds.map((m, i) => (
              <li key={i}>
                {m.name}
                {m.dose ? ` — ${m.dose}` : ''}
                {m.frequency ? ` (${m.frequency})` : ''}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Clinical summary">{s.clinical_summary.summary || '—'}</Section>
    </div>
  );
}

function SimplifiedView({ s }: { s: SimplifiedMedicalSummary }) {
  return (
    <div className="flex flex-col gap-3">
      <Section title="Chief complaint">{s.chief_complaint || '—'}</Section>
      {s.symptoms?.length ? (
        <Section title="Symptoms">
          <ul className="list-inside list-disc">
            {s.symptoms.map((sym, i) => (
              <li key={i}>{sym}</li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Assessment">{s.assessment || '—'}</Section>
      <Section title="Treatment plan">{s.treatment_plan || '—'}</Section>
      <Section title="Summary">{s.summary || '—'}</Section>
    </div>
  );
}

function SoapView({ s }: { s: SoapMedicalSummary }) {
  return (
    <div className="flex flex-col gap-3">
      <Section title="Subjective">{s.subjective || '—'}</Section>
      <Section title="Objective">{s.objective || '—'}</Section>
      <Section title="Assessment">{s.assessment || '—'}</Section>
      <Section title="Plan">{s.plan || '—'}</Section>
    </div>
  );
}

export function SummaryView({ summary }: { summary: SummaryResponse }) {
  const s = summary.summary;
  if (isEnhanced(s)) return <EnhancedView s={s} />;
  if (isSoap(s)) return <SoapView s={s} />;
  return <SimplifiedView s={s as SimplifiedMedicalSummary} />;
}

// =============================================================================
// Streaming preview (R10)
// =============================================================================

/** Rough token estimate for the live counter — whitespace-split, not a real tokenizer. */
function estimateTokenCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Shown in place of the `<Skeleton>` while a `stream:true` request is in
 * flight: the raw accumulated SSE text plus a live character/token counter.
 * Swapped out for `SummaryView`/the pre-summary text block once the terminal
 * `result` event resolves the request.
 */
export function StreamingPreview({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{label}</h3>
          <Badge variant="secondary">Streaming…</Badge>
        </div>
        <Badge variant="outline">
          {text.length} chars · {estimateTokenCount(text)} tokens
        </Badge>
      </div>
      <div className="bg-muted overflow-x-auto rounded p-3 text-sm whitespace-pre-wrap" aria-live="polite">
        {text}
      </div>
    </div>
  );
}
