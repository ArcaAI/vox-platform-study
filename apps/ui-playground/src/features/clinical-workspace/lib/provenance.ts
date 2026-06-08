/**
 * Provenance mapper (TASK-330 P3, WS5).
 *
 * Converts the server `SummaryProvenanceResponse` (whose `citationsMap` arrives
 * as opaque JSON) into the strongly-typed `ClinicalReviewData` the reused
 * `ReviewScreen` renders. Coercion is defensive: malformed claims/evidence are
 * dropped rather than trusted, so a click-to-inspect highlight can never index
 * outside a transcript.
 *
 * Only type-only `@arcaai/vox` imports — safe under the stubbed-SDK test config.
 */
import type {
  CitationClaim,
  CitationsMap,
  ClaimEvidence,
  ClaimStatus,
  ClinicalReviewData,
  SensorScores,
  SoapSection,
  TranscriptSource,
} from '@arcaai/vox';
import type { SummaryProvenanceResponse } from '../types';

const SOAP_SECTIONS: readonly SoapSection[] = ['S', 'O', 'A', 'P'];
const CLAIM_STATUSES: readonly ClaimStatus[] = ['verified', 'unverified', 'flagged'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function coerceEvidence(raw: unknown): ClaimEvidence | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const transcriptContextItemId = rec.transcriptContextItemId;
  const startOffset = rec.startOffset;
  const endOffset = rec.endOffset;
  if (typeof transcriptContextItemId !== 'string') return null;
  if (typeof startOffset !== 'number' || typeof endOffset !== 'number') return null;
  if (startOffset < 0 || endOffset < startOffset) return null;
  return {
    transcriptContextItemId,
    startOffset,
    endOffset,
    quote: typeof rec.quote === 'string' ? rec.quote : '',
  };
}

function coerceClaim(raw: unknown): CitationClaim | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  if (typeof rec.id !== 'string' || typeof rec.text !== 'string') return null;

  const section = SOAP_SECTIONS.includes(rec.section as SoapSection) ? (rec.section as SoapSection) : 'A';
  const status = CLAIM_STATUSES.includes(rec.status as ClaimStatus) ? (rec.status as ClaimStatus) : 'unverified';
  const evidence = Array.isArray(rec.evidence) ? rec.evidence.map(coerceEvidence).filter((e): e is ClaimEvidence => e !== null) : [];

  return {
    id: rec.id,
    text: rec.text,
    section,
    status,
    confidence: typeof rec.confidence === 'number' ? rec.confidence : 0,
    evidence,
    entityRefs: Array.isArray(rec.entityRefs) ? rec.entityRefs.filter((r): r is string => typeof r === 'string') : [],
    knowledgeChunkIds: Array.isArray(rec.knowledgeChunkIds) ? rec.knowledgeChunkIds.filter((r): r is string => typeof r === 'string') : [],
  };
}

/** Coerce the opaque `citationsMap` payload into a typed `CitationsMap`. */
export function coerceCitationsMap(raw: unknown): CitationsMap {
  const rec = asRecord(raw);
  const claimsRaw = rec && Array.isArray(rec.claims) ? rec.claims : [];
  return { claims: claimsRaw.map(coerceClaim).filter((c): c is CitationClaim => c !== null) };
}

/** Coerce the sensor-score block, returning `undefined` when absent/empty. */
export function coerceSensorScores(raw: SummaryProvenanceResponse['sensorScores']): SensorScores | undefined {
  if (!raw) return undefined;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    entityFaithfulness: num(raw.entityFaithfulness),
    coverage: num(raw.coverage),
    schemaValid: num(raw.schemaValid),
    citationPresence: num(raw.citationPresence),
    numericDose: num(raw.numericDose),
  };
}

export interface MapProvenanceInput {
  provenance: SummaryProvenanceResponse;
  consultationId: string;
  noteContextItemId: string;
  transcripts: TranscriptSource[];
  status?: string;
}

/** Build the review aggregate the linked-evidence screen renders. */
export function mapProvenanceToReviewData(input: MapProvenanceInput): ClinicalReviewData {
  const { provenance, consultationId, noteContextItemId, transcripts, status } = input;
  return {
    consultationId,
    noteContextItemId,
    transcripts,
    citationsMap: coerceCitationsMap(provenance.citationsMap),
    sensorScores: coerceSensorScores(provenance.sensorScores),
    modelName: provenance.modelName,
    status: status ?? provenance.status,
  };
}
