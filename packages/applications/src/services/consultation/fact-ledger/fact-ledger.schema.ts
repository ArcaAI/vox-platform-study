import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The per-encounter fact ledger: the extractor's output contract, the stored `FactLedgerV1`, and
 * the rules code owns on top of the model (criticality, the input digest).
 */

/**
 * Lineage key of the extractor agent. Mirrors `FACT_LEDGER_AGENT_SLUG` in
 * `packages/database/src/prisma/db_main/seed/25-agents.ts` (parity is test-pinned): the producer
 * names it by slug because the agent carries no assignment.
 */
export const FACT_LEDGER_AGENT_SLUG = 'fact-ledger-extraction';

export const FACT_LEDGER_SCHEMA = 'hope.fact_ledger.v1';

export const FACT_KINDS = [
  'complaint',
  'history',
  'medication',
  'dose_change',
  'allergy',
  'vital',
  'exam',
  'result',
  'diagnosis',
  'plan',
  'order',
  'follow_up',
  'red_flag',
  'negation',
  'other',
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

/** Kinds that are always critical; a `result` is critical only when it reads as abnormal. */
const CRITICAL_KINDS: ReadonlySet<FactKind> = new Set<FactKind>([
  'medication',
  'dose_change',
  'allergy',
  'diagnosis',
  'plan',
  'order',
  'follow_up',
  'red_flag',
]);

const ABNORMAL_RESULT = /\b(abnormal|high|low|elevated|raised|increased|decreased|reduced|deranged|positive|critical)\b/i;

/** Criticality is decided by code, never by the model's own flag. */
export function isCriticalFact(kind: FactKind, statement: string): boolean {
  if (CRITICAL_KINDS.has(kind)) return true;
  return kind === 'result' && ABNORMAL_RESULT.test(statement);
}

const numberSchema = z.object({ value: z.string(), unit: z.string().optional() });

/** One fact as the extractor returns it. Ids, criticality and supersession from the model are ignored. */
export const modelFactSchema = z.object({
  key: z.string().trim().min(1),
  kind: z.enum(FACT_KINDS),
  statement: z.string().trim().min(1),
  citations: z.array(z.string()),
  numbers: z.array(numberSchema).optional(),
  aliases: z.array(z.string()).optional(),
  sectionHint: z.string().optional(),
});

export type ModelFact = z.infer<typeof modelFactSchema>;

/** The envelope must parse; each fact is validated on its own so one malformed fact drops alone. */
export const modelOutputEnvelopeSchema = z.object({ facts: z.array(z.unknown()) });

export const ledgerFactSchema = z.object({
  /** `E{encounterSeq}-F{n}`, in transcript order. */
  factId: z.string(),
  key: z.string(),
  kind: z.enum(FACT_KINDS),
  statement: z.string(),
  critical: z.boolean(),
  numbers: z.array(numberSchema),
  aliases: z.array(z.string()),
  /** Context item ids: TRANSCRIPT_SEGMENT ids, or the TRANSCRIPT item of an uploaded audio file. */
  citations: z.array(z.string()).min(1),
  sectionHint: z.string().optional(),
  supersedes: z.array(z.string()).optional(),
  supersededBy: z.string().nullable().optional(),
});

export type LedgerFact = z.infer<typeof ledgerFactSchema>;

export const factLedgerV1Schema = z.object({
  schema: z.literal(FACT_LEDGER_SCHEMA),
  consultationId: z.string(),
  encounterSeq: z.number().int(),
  inputDigest: z.string(),
  /** The segment versions the ledger was built from; `label` is what the model saw (`S<segmentSeq>`). */
  sources: z.array(z.object({ segmentId: z.string(), versionNumber: z.number().int(), label: z.string() })),
  /** Uploaded-audio transcripts of the encounter (`A<n>`). */
  attachmentSources: z.array(z.object({ itemId: z.string(), versionNumber: z.number().int(), label: z.string() })),
  agent: z.object({ slug: z.string(), version: z.number().int() }),
  model: z.string().nullable(),
  createdAt: z.string(),
  facts: z.array(ledgerFactSchema),
  stats: z.object({
    segmentCount: z.number().int(),
    attachmentCount: z.number().int(),
    factCount: z.number().int(),
    criticalCount: z.number().int(),
    droppedUncited: z.number().int(),
    droppedInvalid: z.number().int(),
    callCount: z.number().int(),
  }),
});

export type FactLedgerV1 = z.infer<typeof factLedgerV1Schema>;

/** Parse a stored ledger body; `null` for anything that is not a v1 ledger. */
export function parseStoredLedger(raw: string | null | undefined): FactLedgerV1 | null {
  if (!raw) return null;
  try {
    const parsed = factLedgerV1Schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * `sha256:` over the sorted `segmentId:versionNumber` lines plus `A:itemId:versionNumber` for each
 * uploaded-audio transcript. Order-independent, and changes on any segment edit or new attachment.
 */
export function computeInputDigest(
  segments: ReadonlyArray<{ id: string; versionNumber: number }>,
  attachments: ReadonlyArray<{ id: string; versionNumber: number }>,
): string {
  const lines = [...segments.map((s) => `${s.id}:${s.versionNumber}`), ...attachments.map((a) => `A:${a.id}:${a.versionNumber}`)].sort();
  return `sha256:${createHash('sha256').update(lines.join('\n')).digest('hex')}`;
}
