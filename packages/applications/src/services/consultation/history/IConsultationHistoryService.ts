import type { ActivityKind, ActivityRunRecord, ConsultationActivityPage, EncounterRecap, ItemVersionDetail, ItemVersionSummary } from '@arcaai/types';
import type { VersionDiffResponse } from '../context/dto/version-diff.response';
import type { FeedbackResponse } from '../feedback/dto/feedback.response';

export type { HistoryItemHeader, HistoryItemRow, HistoryPageInput, HistoryVersionMetaRow } from '@arcaai/domains';

/** Which plane is reading: the admin plane is gated and sees runs and aggregates; the business plane is not and does not. */
export interface HistoryReadOptions {
  admin: boolean;
}

/** `GET …/activity` (admin) and `GET …/history` (business), already parsed. */
export interface ConsultationActivityQueryInput {
  cursor?: string;
  limit?: number;
  kinds?: ReadonlyArray<ActivityKind | string>;
  encounterSeq?: number;
  edited?: boolean;
  aiRuns?: boolean;
  grouping?: 'runs' | 'none';
  segmentSeqFrom?: number;
  segmentSeqTo?: number;
  include?: ReadonlyArray<string>;
}

export abstract class IConsultationHistoryService {
  /** One oldest-first page of the consultation's activity. */
  abstract getActivity(consultationId: string, query: ConsultationActivityQueryInput, options: HistoryReadOptions): Promise<ConsultationActivityPage>;
  /** An item's versions, newest first, without content. */
  abstract listItemVersions(consultationId: string, contextItemId: string, options: HistoryReadOptions): Promise<ItemVersionSummary[]>;
  /** One version of an item, decrypted. */
  abstract getItemVersion(
    consultationId: string,
    contextItemId: string,
    versionNumber: number,
    options: HistoryReadOptions,
  ): Promise<ItemVersionDetail>;
  /** Version `versionNumber` against version `against` (`from` = against, `to` = versionNumber). */
  abstract diffItemVersions(
    consultationId: string,
    contextItemId: string,
    versionNumber: number,
    against: number,
    options: HistoryReadOptions,
  ): Promise<VersionDiffResponse>;
  /** The run that produced an item version (latest when `versionNumber` is absent); empty when none is recorded. */
  abstract listItemRuns(
    consultationId: string,
    contextItemId: string,
    versionNumber: number | undefined,
    options: HistoryReadOptions,
  ): Promise<ActivityRunRecord[]>;
  /** The live recap of one encounter (display-only). */
  abstract getRecap(consultationId: string, encounterSeq: number, options: HistoryReadOptions): Promise<EncounterRecap>;
}

export const IConsultationHistoryServiceToken = Symbol('IConsultationHistoryService');

/**
 * The feedback the history feed interleaves. Bound to the consultation feedback service at module
 * assembly; optional, so the feed renders without it.
 */
export abstract class ConsultationActivityFeedbackSource {
  abstract listForActivity(
    consultationId: string,
    page: { cursor?: string | null; limit?: number },
  ): Promise<{ items: FeedbackResponse[]; nextCursor: string | null }>;
}

export const ConsultationActivityFeedbackSourceToken = Symbol('ConsultationActivityFeedbackSource');
