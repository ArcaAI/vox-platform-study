import { ContextItemType } from '@arcaai/domains';
import type {
  ActivityFeedbackEntry,
  ActivityKind,
  ActivityLifecycleEntry,
  ActivityRunRecord,
  EncounterBlock,
  ItemVersionDetail,
  ItemVersionSummary,
  RunSummary,
} from '@arcaai/types';
import type { ActivityRunProducer } from '../../ai-activity-run/IAiActivityRunService';
import type { FeedbackResponse } from '../feedback/dto/feedback.response';
import type { HistoryVersionMetaRow } from './IConsultationHistoryService';

/**
 * The item types each activity kind lists. FEEDBACK and LIFECYCLE are not items. A TRANSCRIPT item
 * is the transcript of an uploaded audio attachment (the consultation's own transcript is
 * FULL_TRANSCRIPT), so it lists under ATTACHMENT.
 */
export const ACTIVITY_KIND_ITEM_TYPES: Readonly<Partial<Record<ActivityKind, readonly ContextItemType[]>>> = {
  TRANSCRIPT_SEGMENT: [ContextItemType.TRANSCRIPT_SEGMENT],
  FULL_TRANSCRIPT: [ContextItemType.FULL_TRANSCRIPT],
  NOTE: [ContextItemType.RAW_SUMMARY, ContextItemType.MODIFIED_SUMMARY, ContextItemType.SIGNED_NOTE],
  PRE_SUMMARY: [ContextItemType.PRE_SUMMARY],
  CASE_NOTE: [ContextItemType.CASE_NOTE, ContextItemType.WORKNOTE],
  ATTACHMENT: [ContextItemType.ATTACHMENT, ContextItemType.TRANSCRIPT],
  RECORDING: [ContextItemType.AUDIO_RECORDING],
  FACT_LEDGER: [ContextItemType.FACT_LEDGER],
  ENCOUNTER_RECAP: [ContextItemType.ENCOUNTER_RECAP],
  STRUCTURED: [ContextItemType.STRUCTURED],
};

const TYPE_KIND = new Map<ContextItemType, ActivityKind>(
  Object.entries(ACTIVITY_KIND_ITEM_TYPES).flatMap(([kind, types]) => (types ?? []).map((type) => [type, kind as ActivityKind] as const)),
);

interface EncounterLike {
  seq: number;
  visitType: string;
  externalRef?: string | null;
  startedAt: Date;
  endedAt?: Date | null;
  recordingStartMs?: number | null;
  recordingEndMs?: number | null;
}

interface ApprovalLike {
  id: string;
  approvedAt: Date;
  approvedBy: string;
}

/** A lifecycle entry plus the synthetic id that orders it on the keyset. */
export interface KeyedLifecycleEntry {
  id: string;
  entry: ActivityLifecycleEntry;
}

const num = (value: number | null | undefined): number => value ?? 0;
const bigToNumber = (value: bigint | number | null | undefined): number | null => (value === null || value === undefined ? null : Number(value));

export class ConsultationHistoryDtoMapper {
  /** The activity kind of an item type, or null for a type the feed does not list. */
  static kindOf(type: ContextItemType): ActivityKind | null {
    return TYPE_KIND.get(type) ?? null;
  }

  /** Encounters in seq order, each with the idle gap before the next one starts. */
  static toEncounterBlocks(encounters: readonly EncounterLike[]): EncounterBlock[] {
    const sorted = [...encounters].sort((a, b) => a.seq - b.seq);
    return sorted.map((encounter, index) => {
      const block: EncounterBlock = {
        seq: encounter.seq,
        visitType: encounter.visitType,
        externalRef: encounter.externalRef ?? null,
        startedAt: encounter.startedAt.toISOString(),
        endedAt: encounter.endedAt ? encounter.endedAt.toISOString() : null,
        recordingStartMs: encounter.recordingStartMs ?? null,
        recordingEndMs: encounter.recordingEndMs ?? null,
      };
      const next = sorted[index + 1];
      if (encounter.endedAt && next) {
        const durationMs = next.startedAt.getTime() - encounter.endedAt.getTime();
        if (durationMs > 0) block.gapAfter = { fromAt: encounter.endedAt.toISOString(), toAt: next.startedAt.toISOString(), durationMs };
      }
      return block;
    });
  }

  /**
   * Lifecycle entries derivable from stored rows: each encounter's start (`opened` for the first,
   * `encounter_appended` after) and end (`stopped`), each approval, and the close.
   */
  static toLifecycleEntries(encounters: readonly EncounterLike[], approvals: readonly ApprovalLike[], closedAt: Date | null | undefined): Array<KeyedLifecycleEntry & { at: Date }> {
    const out: Array<KeyedLifecycleEntry & { at: Date }> = [];
    for (const encounter of encounters) {
      const startType = encounter.seq <= 1 ? 'opened' : 'encounter_appended';
      out.push({ id: `lifecycle:${startType}:${encounter.seq}`, at: encounter.startedAt, entry: { entryType: 'lifecycle', at: encounter.startedAt.toISOString(), type: startType } });
      if (encounter.endedAt) {
        out.push({ id: `lifecycle:stopped:${encounter.seq}`, at: encounter.endedAt, entry: { entryType: 'lifecycle', at: encounter.endedAt.toISOString(), type: 'stopped' } });
      }
    }
    for (const approval of approvals) {
      out.push({
        id: `lifecycle:approved:${approval.id}`,
        at: approval.approvedAt,
        entry: { entryType: 'lifecycle', at: approval.approvedAt.toISOString(), type: 'approved', actor: { userId: approval.approvedBy } },
      });
    }
    if (closedAt) out.push({ id: 'lifecycle:closed', at: closedAt, entry: { entryType: 'lifecycle', at: closedAt.toISOString(), type: 'closed' } });
    return out;
  }

  static toFeedbackEntry(feedback: FeedbackResponse): ActivityFeedbackEntry {
    return {
      entryType: 'feedback',
      id: feedback.id,
      occurredAt: feedback.createdAt,
      rating: feedback.rating ?? null,
      reasonCodes: feedback.reasonCodes ?? [],
      comment: feedback.comment ?? null,
      target: feedback.target
        ? {
            kind: feedback.target.kind,
            contextItemId: feedback.target.contextItemId,
            ...(feedback.target.versionNumber != null ? { versionNumber: feedback.target.versionNumber } : {}),
            ...(feedback.target.sectionKey ? { sectionKey: feedback.target.sectionKey } : {}),
            ...(feedback.target.documentKey ? { documentKey: feedback.target.documentKey } : {}),
            ...(feedback.target.entityRef ? { entityRef: feedback.target.entityRef } : {}),
          }
        : null,
      actor: { userId: feedback.actor.userId, credentialClass: feedback.actor.credentialClass },
      ...(feedback.client?.app ? { clientApp: feedback.client.app } : {}),
      ...(feedback.client?.surface ? { surface: feedback.client.surface } : {}),
      ...(feedback.provenance ? { provenance: { ...feedback.provenance } } : {}),
    };
  }

  static toRunSummary(producer: ActivityRunProducer): RunSummary {
    return {
      runId: producer.activityRunId,
      workflowSlug: producer.workflowSlug ?? '',
      workflowVersion: producer.workflowVersion ?? '',
      agentSlug: producer.agentSlug ?? '',
      agentVersion: producer.agentVersion ?? '',
      model: producer.modelName ?? '',
      provider: producer.provider ?? '',
      durationMs: num(producer.durationMs),
      tokensIn: num(producer.tokensIn),
      tokensOut: num(producer.tokensOut),
      contextUsed: num(producer.contextUsed),
      contextWindow: num(producer.contextWindow),
      costMicros: bigToNumber(producer.costMicros),
      costBasis: producer.costBasis ?? null,
      stopReason: producer.stopReason ?? null,
      startedAt: producer.startedAt.toISOString(),
    };
  }

  static toRunRecord(producer: ActivityRunProducer, versionNumber: number): ActivityRunRecord {
    return {
      ...ConsultationHistoryDtoMapper.toRunSummary(producer),
      id: producer.activityRunId,
      nodeId: producer.nodeId ?? '',
      activityKind: String(producer.activityKind),
      outputCap: producer.outputCap ?? null,
      deployment: producer.deployment ?? null,
      endedAt: (producer.endedAt ?? producer.startedAt).toISOString(),
      versionNumber,
    };
  }

  static toVersionSummary(meta: HistoryVersionMetaRow): ItemVersionSummary {
    return {
      versionNumber: meta.versionNumber,
      changeSource: meta.changeSource ?? 'unknown',
      changedBy: meta.changedBy ?? null,
      changeReason: meta.changeReason ?? null,
      createdAt: meta.createdAt.toISOString(),
    };
  }

  static toVersionDetail(version: {
    contextItemId: string;
    versionNumber: number;
    content?: string | null;
    changeSource?: string | null;
    changedBy?: string | null;
    changeReason?: string | null;
    createdAt: Date;
  }): ItemVersionDetail {
    return {
      contextItemId: version.contextItemId,
      versionNumber: version.versionNumber,
      content: version.content ?? null,
      changeSource: version.changeSource ?? 'unknown',
      changedBy: version.changedBy ?? null,
      changeReason: version.changeReason ?? null,
      createdAt: version.createdAt.toISOString(),
    };
  }
}
