import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    ConsultationRepository,
    ContextItemRepository,
    NamedEntityRepository,
    ResourceType,
    SysEventType,
    ConsultationEntity,
    ContextItemEntity,
    ContextItemType,
} from '@arcaai/domains';
import {
    TimelineEventResponse,
    TimelineEventType,
    ConsultationTimelineResponse,
} from './dto';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

/**
 * Timeline Service
 *
 * Builds a chronological timeline of events across a consultation chain.
 * Supports two scopes:
 *   - 'single': events from one consultation only
 *   - 'chain':  events from the full chain + same-day consultations
 *
 * Events are derived from:
 *   - Consultation creation timestamps  →  consultation_opened
 *   - ContextItem creation timestamps   →  context_added / transcription_completed / summary_generated / etc.
 *   - ContextItem update timestamps     →  context_updated / summary_updated
 *   - NamedEntity creation timestamps   →  ner_extracted (grouped per context item)
 */
@Injectable()
export class TimelineService extends BaseService {
    constructor(
        private readonly consultationRepository: ConsultationRepository,
        private readonly contextItemRepository: ContextItemRepository,
        private readonly namedEntityRepository: NamedEntityRepository,
        protected override readonly eventEmitter: EventEmitter2,
        protected override readonly clsService: ClsService<IActiveUserContext>,
    ) {
        super(eventEmitter, clsService, ResourceType.Consultation);
    }

    /**
     * Build a timeline for a consultation.
     *
     * @param consultationId - The consultation to build the timeline for
     * @param scope - 'single' for one consultation, 'chain' for full chain + same-day
     */
    async getTimeline(
        consultationId: string,
        scope: 'single' | 'chain' = 'chain',
    ): Promise<ConsultationTimelineResponse> {
        const consultationIds = scope === 'chain'
            ? await this.resolveLinkedConsultationIds(consultationId)
            : [consultationId];

        if (consultationIds.length === 0) {
            return {
                consultationId,
                scope,
                events: [],
                totalEvents: 0,
                sources: [],
            };
        }

        // Fetch consultations with relations for metadata
        const consultations = await this.fetchConsultationsWithRelations(consultationIds);
        const consultationMap = new Map(consultations.map(c => [c.id, c]));

        // Build source list
        const sources = consultations.map(c => ({
            consultationId: c.id,
            department: c.Department?.name ?? undefined,
            doctor: this.formatDoctorName(c),
        }));

        // Collect events from all sources
        const events: TimelineEventResponse[] = [];

        // 1. Consultation opened events
        for (const consultation of consultations) {
            events.push({
                timestamp: consultation.createdAt.toISOString(),
                type: TimelineEventType.ConsultationOpened,
                consultationId: consultation.id,
                department: consultation.Department?.name ?? undefined,
                departmentId: consultation.departmentId ?? undefined,
                doctor: this.formatDoctorName(consultation),
                doctorId: consultation.doctorId,
            });
        }

        // 2. Context item events
        for (const cId of consultationIds) {
            const contextItems = await this.contextItemRepository.findByConsultation(cId);
            const consultation = consultationMap.get(cId);

            for (const item of contextItems) {
                const baseEvent = {
                    consultationId: cId,
                    department: consultation?.Department?.name ?? undefined,
                    departmentId: consultation?.departmentId ?? undefined,
                    doctor: this.formatDoctorName(consultation),
                    doctorId: consultation?.doctorId,
                    contextItemId: item.id,
                };

                events.push(...this.contextItemToEvents(item, baseEvent));
            }
        }

        // 3. NER extraction events (grouped per context item that has entities)
        for (const cId of consultationIds) {
            const contextItems = await this.contextItemRepository.findByConsultation(cId);
            const consultation = consultationMap.get(cId);

            for (const item of contextItems) {
                if (item.isSummary || item.isTranscript) {
                    const entities = await this.namedEntityRepository.findByContextItem(item.id);
                    if (entities.length > 0) {
                        const latestEntity = entities.reduce((latest, e) =>
                            e.createdAt > latest.createdAt ? e : latest,
                        );
                        events.push({
                            timestamp: latestEntity.createdAt.toISOString(),
                            type: TimelineEventType.NerExtracted,
                            consultationId: cId,
                            department: consultation?.Department?.name ?? undefined,
                            departmentId: consultation?.departmentId ?? undefined,
                            doctor: this.formatDoctorName(consultation),
                            doctorId: consultation?.doctorId,
                            contextItemId: item.id,
                            entityCount: entities.length,
                        });
                    }
                }
            }
        }

        // Sort chronologically
        events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            data: { consultationId, scope, eventCount: events.length, sourceCount: sources.length },
        });

        return {
            consultationId,
            scope,
            events,
            totalEvents: events.length,
            sources,
        };
    }

    // ============================================
    // Private Helpers
    // ============================================

    /**
     * Convert a ContextItemEntity into one or more timeline events
     * based on its type, creation time, and update time.
     */
    private contextItemToEvents(
        item: ContextItemEntity,
        baseEvent: Partial<TimelineEventResponse>,
    ): TimelineEventResponse[] {
        const events: TimelineEventResponse[] = [];
        const contextType = item.type;

        // Map context item type to timeline event type
        const eventType = this.mapContextTypeToEventType(contextType);

        // Creation event
        events.push({
            ...baseEvent,
            timestamp: item.createdAt.toISOString(),
            type: eventType,
            contextType,
            wordCount: item.isTranscript ? this.countWords(item.content) : undefined,
            aiModel: item.SummaryMeta?.aiModelId ?? undefined,
            versionNumber: 1,
        } as TimelineEventResponse);

        // Update event (if item was updated after creation)
        if (item.currentVersionNumber > 1 && item.updatedAt > item.createdAt) {
            const updateType = item.isSummary
                ? TimelineEventType.SummaryUpdated
                : TimelineEventType.ContextUpdated;

            events.push({
                ...baseEvent,
                timestamp: item.updatedAt.toISOString(),
                type: updateType,
                contextType,
                versionNumber: item.currentVersionNumber,
            } as TimelineEventResponse);
        }

        return events;
    }

    /**
     * Map ContextItemType to the appropriate TimelineEventType for creation.
     */
    private mapContextTypeToEventType(type: ContextItemType): TimelineEventType {
        switch (type) {
            case ContextItemType.TRANSCRIPT:
                return TimelineEventType.TranscriptionCompleted;
            case ContextItemType.RAW_SUMMARY:
            case ContextItemType.MODIFIED_SUMMARY:
                return TimelineEventType.SummaryGenerated;
            case ContextItemType.PRE_SUMMARY:
                return TimelineEventType.PreSummaryGenerated;
            default:
                return TimelineEventType.ContextAdded;
        }
    }

    /**
     * Count words in text content.
     */
    private countWords(content?: string | null): number | undefined {
        if (!content) return undefined;
        return content.trim().split(/\s+/).filter(Boolean).length;
    }

    /**
     * Format doctor name from consultation entity's Doctor relation.
     */
    private formatDoctorName(consultation?: ConsultationEntity | null): string | undefined {
        if (!consultation?.Doctor) return undefined;
        const profile = (consultation.Doctor as any).UserProfile;
        if (profile?.firstName || profile?.lastName) {
            return [profile.firstName, profile.lastName].filter(Boolean).join(' ');
        }
        return consultation.Doctor.username;
    }

    /**
     * Resolve all linked consultation IDs (chain + same-day).
     * Mirrors the logic in ContextService.resolveLinkedConsultationIds().
     */
    private async resolveLinkedConsultationIds(consultationId: string): Promise<string[]> {
        const consultation = await this.consultationRepository.findById(consultationId);
        if (!consultation) return [];

        const chain = await this.consultationRepository.findConsultationChain(consultationId);
        const chainIds = new Set(chain.map(c => c.id));

        const sameDayConsultations = await this.consultationRepository.findByPatientAndDate(
            consultation.tenantId,
            consultation.patientId,
            consultation.appointmentDate,
        );
        const sameDayIds = sameDayConsultations.map(c => c.id);

        return [...new Set([...chainIds, ...sameDayIds])];
    }

    /**
     * Fetch multiple consultations with Doctor and Department relations.
     */
    private async fetchConsultationsWithRelations(
        ids: string[],
    ): Promise<ConsultationEntity[]> {
        const results: ConsultationEntity[] = [];
        for (const id of ids) {
            const consultation = await this.consultationRepository.findWithRelations(id);
            if (consultation) {
                results.push(consultation);
            }
        }
        return results;
    }
}
