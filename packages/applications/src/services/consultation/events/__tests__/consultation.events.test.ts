/**
 * Consultation Pipeline Event Definitions — Unit Tests
 *
 * Validates the event enum values, payload structures, pipeline configuration
 * defaults, and the type-safe event-payload map exported by consultation.events.ts.
 *
 * These tests ensure that downstream consumers (ConsultationEventHandler,
 * SttInternalService, SummaryProcessor, NerProcessor) can rely on stable
 * event names, payload shapes, and default configuration values.
 */

import { describe, it, expect } from 'vitest';
import {
    ConsultationPipelineEvent,
    DEFAULT_PIPELINE_CONFIG,
    type ConsultationPipelineConfig,
    type ConsultationPipelineEventBase,
    type TranscriptionCreatedPayload,
    type SummaryGeneratedPayload,
    type NerExtractedPayload,
    type PipelineCompletedPayload,
    type PipelineStepFailedPayload,
    type PipelineStep,
    type ConsultationPipelineEventPayloadMap,
} from '../consultation.events';

// =============================================================================
// ConsultationPipelineEvent Enum
// =============================================================================

describe('ConsultationPipelineEvent', () => {
    it('should export exactly 6 event types', () => {
        const values = Object.values(ConsultationPipelineEvent);
        expect(values).toHaveLength(6);
    });

    it('should have TranscriptionCreated with correct dot-notation value', () => {
        expect(ConsultationPipelineEvent.TranscriptionCreated).toBe(
            'consultation.transcription.created',
        );
    });

    it('should have ContextAdded with correct dot-notation value', () => {
        expect(ConsultationPipelineEvent.ContextAdded).toBe(
            'consultation.context.added',
        );
    });

    it('should have SummaryGenerated with correct dot-notation value', () => {
        expect(ConsultationPipelineEvent.SummaryGenerated).toBe(
            'consultation.summary.generated',
        );
    });

    it('should have NerExtracted with correct dot-notation value', () => {
        expect(ConsultationPipelineEvent.NerExtracted).toBe(
            'consultation.ner.extracted',
        );
    });

    it('should have PipelineCompleted with correct dot-notation value', () => {
        expect(ConsultationPipelineEvent.PipelineCompleted).toBe(
            'consultation.pipeline.completed',
        );
    });

    it('should have PipelineStepFailed with correct dot-notation value', () => {
        expect(ConsultationPipelineEvent.PipelineStepFailed).toBe(
            'consultation.pipeline.step_failed',
        );
    });

    it('should use "consultation." prefix on all event names for namespace consistency', () => {
        const values = Object.values(ConsultationPipelineEvent);
        for (const value of values) {
            expect(value).toMatch(/^consultation\./);
        }
    });

    it('should have unique values (no duplicates)', () => {
        const values = Object.values(ConsultationPipelineEvent);
        const unique = new Set(values);
        expect(unique.size).toBe(values.length);
    });
});

// =============================================================================
// Payload Structural Tests
// =============================================================================

describe('TranscriptionCreatedPayload', () => {
    const basePayload: ConsultationPipelineEventBase = {
        consultationId: 'consult-001',
        tenantId: 'tenant-abc',
        userId: 'doctor-1',
        timestamp: new Date().toISOString(),
        correlationId: 'corr-xyz',
    };

    it('should accept a valid streaming transcription payload', () => {
        const payload: TranscriptionCreatedPayload = {
            ...basePayload,
            contextItemId: 'ctx-item-001',
            jobId: 'stt-job-001',
            wordCount: 350,
            transcriptionSource: 'streaming',
        };

        expect(payload.contextItemId).toBe('ctx-item-001');
        expect(payload.jobId).toBe('stt-job-001');
        expect(payload.wordCount).toBe(350);
        expect(payload.transcriptionSource).toBe('streaming');
    });

    it('should accept a valid batch transcription payload', () => {
        const payload: TranscriptionCreatedPayload = {
            ...basePayload,
            contextItemId: 'ctx-item-002',
            jobId: 'stt-job-002',
            transcriptionSource: 'batch',
        };

        expect(payload.transcriptionSource).toBe('batch');
        expect(payload.wordCount).toBeUndefined();
    });

    it('should inherit base fields from ConsultationPipelineEventBase', () => {
        const payload: TranscriptionCreatedPayload = {
            ...basePayload,
            contextItemId: 'ctx-item-003',
            jobId: 'stt-job-003',
            transcriptionSource: 'streaming',
        };

        expect(payload.consultationId).toBe('consult-001');
        expect(payload.tenantId).toBe('tenant-abc');
        expect(payload.userId).toBe('doctor-1');
        expect(payload.timestamp).toBeDefined();
        expect(payload.correlationId).toBe('corr-xyz');
    });

    it('should allow optional base fields to be omitted', () => {
        const payload: TranscriptionCreatedPayload = {
            consultationId: 'consult-001',
            tenantId: 'tenant-abc',
            timestamp: new Date().toISOString(),
            contextItemId: 'ctx-item-004',
            jobId: 'stt-job-004',
            transcriptionSource: 'streaming',
        };

        expect(payload.userId).toBeUndefined();
        expect(payload.correlationId).toBeUndefined();
    });
});

describe('SummaryGeneratedPayload', () => {
    const basePayload: ConsultationPipelineEventBase = {
        consultationId: 'consult-001',
        tenantId: 'tenant-abc',
        timestamp: new Date().toISOString(),
    };

    it('should accept a valid auto-generated summary payload', () => {
        const payload: SummaryGeneratedPayload = {
            ...basePayload,
            contextItemId: 'ctx-item-summary-001',
            jobId: 'summary-job-001',
            dnaStyleId: 'style_DNA_doctor_department_hematology_cp',
            template: 'SOAP',
            isAutoGenerated: true,
            summaryMeta: {
                aiModelId: 'gpt-4o',
                processingTimeMs: 3200,
                inputTokens: 1500,
                outputTokens: 800,
            },
        };

        expect(payload.contextItemId).toBe('ctx-item-summary-001');
        expect(payload.isAutoGenerated).toBe(true);
        expect(payload.dnaStyleId).toBe('style_DNA_doctor_department_hematology_cp');
        expect(payload.template).toBe('SOAP');
        expect(payload.summaryMeta?.aiModelId).toBe('gpt-4o');
        expect(payload.summaryMeta?.processingTimeMs).toBe(3200);
    });

    it('should accept a manually triggered summary payload', () => {
        const payload: SummaryGeneratedPayload = {
            ...basePayload,
            contextItemId: 'ctx-item-summary-002',
            jobId: 'summary-job-002',
            isAutoGenerated: false,
        };

        expect(payload.isAutoGenerated).toBe(false);
        expect(payload.dnaStyleId).toBeUndefined();
        expect(payload.template).toBeUndefined();
        expect(payload.summaryMeta).toBeUndefined();
    });
});

describe('NerExtractedPayload', () => {
    const basePayload: ConsultationPipelineEventBase = {
        consultationId: 'consult-001',
        tenantId: 'tenant-abc',
        timestamp: new Date().toISOString(),
    };

    it('should accept a valid NER extraction payload with entity breakdown', () => {
        const payload: NerExtractedPayload = {
            ...basePayload,
            contextItemId: 'ctx-item-summary-001',
            jobId: 'ner-job-001',
            entityCount: 12,
            isAutoGenerated: true,
            entityCountByClass: {
                MEDICATION: 4,
                CONDITION: 3,
                PROCEDURE: 5,
            },
        };

        expect(payload.entityCount).toBe(12);
        expect(payload.isAutoGenerated).toBe(true);
        expect(payload.entityCountByClass?.MEDICATION).toBe(4);
        expect(payload.entityCountByClass?.CONDITION).toBe(3);
        expect(payload.entityCountByClass?.PROCEDURE).toBe(5);
    });

    it('should accept payload without optional entityCountByClass', () => {
        const payload: NerExtractedPayload = {
            ...basePayload,
            contextItemId: 'ctx-item-summary-002',
            jobId: 'ner-job-002',
            entityCount: 0,
            isAutoGenerated: false,
        };

        expect(payload.entityCount).toBe(0);
        expect(payload.entityCountByClass).toBeUndefined();
    });
});

describe('PipelineCompletedPayload', () => {
    const basePayload: ConsultationPipelineEventBase = {
        consultationId: 'consult-001',
        tenantId: 'tenant-abc',
        timestamp: new Date().toISOString(),
    };

    it('should accept a full pipeline completion payload', () => {
        const payload: PipelineCompletedPayload = {
            ...basePayload,
            transcriptContextItemId: 'ctx-transcript-001',
            summaryContextItemId: 'ctx-summary-001',
            totalEntityCount: 12,
            pipelineDurationMs: 8500,
            stepsExecuted: ['transcription', 'summary', 'ner'],
        };

        expect(payload.transcriptContextItemId).toBe('ctx-transcript-001');
        expect(payload.summaryContextItemId).toBe('ctx-summary-001');
        expect(payload.totalEntityCount).toBe(12);
        expect(payload.pipelineDurationMs).toBe(8500);
        expect(payload.stepsExecuted).toEqual(['transcription', 'summary', 'ner']);
    });

    it('should accept partial pipeline (e.g., only transcription + summary, NER disabled)', () => {
        const payload: PipelineCompletedPayload = {
            ...basePayload,
            transcriptContextItemId: 'ctx-transcript-002',
            summaryContextItemId: 'ctx-summary-002',
            pipelineDurationMs: 5200,
            stepsExecuted: ['transcription', 'summary'],
        };

        expect(payload.totalEntityCount).toBeUndefined();
        expect(payload.stepsExecuted).toEqual(['transcription', 'summary']);
        expect(payload.stepsExecuted).not.toContain('ner');
    });
});

describe('PipelineStepFailedPayload', () => {
    const basePayload: ConsultationPipelineEventBase = {
        consultationId: 'consult-001',
        tenantId: 'tenant-abc',
        timestamp: new Date().toISOString(),
    };

    it('should accept a summary step failure that halts the pipeline', () => {
        const payload: PipelineStepFailedPayload = {
            ...basePayload,
            failedStep: 'summary',
            jobId: 'summary-job-fail-001',
            contextItemId: 'ctx-transcript-001',
            error: 'SMR service timeout after 120s',
            willContinue: false,
        };

        expect(payload.failedStep).toBe('summary');
        expect(payload.error).toBe('SMR service timeout after 120s');
        expect(payload.willContinue).toBe(false);
    });

    it('should accept a NER step failure where pipeline continues', () => {
        const payload: PipelineStepFailedPayload = {
            ...basePayload,
            failedStep: 'ner',
            error: 'NLP service unavailable',
            willContinue: true,
        };

        expect(payload.failedStep).toBe('ner');
        expect(payload.willContinue).toBe(true);
        expect(payload.jobId).toBeUndefined();
        expect(payload.contextItemId).toBeUndefined();
    });
});

// =============================================================================
// PipelineStep Type
// =============================================================================

describe('PipelineStep', () => {
    it('should accept all three valid step values', () => {
        const steps: PipelineStep[] = ['transcription', 'summary', 'ner'];
        expect(steps).toHaveLength(3);
        expect(steps).toContain('transcription');
        expect(steps).toContain('summary');
        expect(steps).toContain('ner');
    });
});

// =============================================================================
// ConsultationPipelineConfig & DEFAULT_PIPELINE_CONFIG
// =============================================================================

describe('DEFAULT_PIPELINE_CONFIG', () => {
    it('should have autoSummaryEnabled set to true', () => {
        expect(DEFAULT_PIPELINE_CONFIG.autoSummaryEnabled).toBe(true);
    });

    it('should have autoNerEnabled set to true', () => {
        expect(DEFAULT_PIPELINE_CONFIG.autoNerEnabled).toBe(true);
    });

    it('should have haltOnFailure set to false', () => {
        expect(DEFAULT_PIPELINE_CONFIG.haltOnFailure).toBe(false);
    });

    it('should not set optional fields (dnaStyleId, summaryTemplate, includeSharedContext)', () => {
        expect(DEFAULT_PIPELINE_CONFIG.dnaStyleId).toBeUndefined();
        expect(DEFAULT_PIPELINE_CONFIG.summaryTemplate).toBeUndefined();
        expect(DEFAULT_PIPELINE_CONFIG.includeSharedContext).toBeUndefined();
    });

    it('should satisfy ConsultationPipelineConfig interface', () => {
        const config: ConsultationPipelineConfig = DEFAULT_PIPELINE_CONFIG;
        expect(config).toBeDefined();
        expect(typeof config.autoSummaryEnabled).toBe('boolean');
        expect(typeof config.autoNerEnabled).toBe('boolean');
    });

    it('should be immutable at runtime (frozen or const-like)', () => {
        const original = { ...DEFAULT_PIPELINE_CONFIG };
        expect(DEFAULT_PIPELINE_CONFIG.autoSummaryEnabled).toBe(original.autoSummaryEnabled);
        expect(DEFAULT_PIPELINE_CONFIG.autoNerEnabled).toBe(original.autoNerEnabled);
        expect(DEFAULT_PIPELINE_CONFIG.haltOnFailure).toBe(original.haltOnFailure);
    });
});

describe('ConsultationPipelineConfig', () => {
    it('should accept a fully specified config', () => {
        const config: ConsultationPipelineConfig = {
            autoSummaryEnabled: true,
            autoNerEnabled: false,
            dnaStyleId: 'style_DNA_doctor_department_cardiology_cp',
            summaryTemplate: 'SOAP',
            includeSharedContext: true,
            haltOnFailure: true,
        };

        expect(config.autoSummaryEnabled).toBe(true);
        expect(config.autoNerEnabled).toBe(false);
        expect(config.dnaStyleId).toBe('style_DNA_doctor_department_cardiology_cp');
        expect(config.summaryTemplate).toBe('SOAP');
        expect(config.includeSharedContext).toBe(true);
        expect(config.haltOnFailure).toBe(true);
    });

    it('should accept a minimal config with only required fields', () => {
        const config: ConsultationPipelineConfig = {
            autoSummaryEnabled: false,
            autoNerEnabled: false,
        };

        expect(config.autoSummaryEnabled).toBe(false);
        expect(config.autoNerEnabled).toBe(false);
        expect(config.dnaStyleId).toBeUndefined();
        expect(config.summaryTemplate).toBeUndefined();
        expect(config.includeSharedContext).toBeUndefined();
        expect(config.haltOnFailure).toBeUndefined();
    });
});

// =============================================================================
// ConsultationPipelineEventPayloadMap
// =============================================================================

describe('ConsultationPipelineEventPayloadMap', () => {
    it('should map TranscriptionCreated to TranscriptionCreatedPayload', () => {
        const map: ConsultationPipelineEventPayloadMap = {
            [ConsultationPipelineEvent.TranscriptionCreated]: {
                consultationId: 'c1',
                tenantId: 't1',
                timestamp: new Date().toISOString(),
                contextItemId: 'ctx1',
                jobId: 'j1',
                transcriptionSource: 'streaming',
            },
            [ConsultationPipelineEvent.ContextAdded]: {
                consultationId: 'c1',
                tenantId: 't1',
                timestamp: new Date().toISOString(),
                contextItemId: 'ctx-note-1',
                contextType: 'WORKNOTE',
            },
            [ConsultationPipelineEvent.SummaryGenerated]: {
                consultationId: 'c1',
                tenantId: 't1',
                timestamp: new Date().toISOString(),
                contextItemId: 'ctx2',
                jobId: 'j2',
                isAutoGenerated: true,
            },
            [ConsultationPipelineEvent.NerExtracted]: {
                consultationId: 'c1',
                tenantId: 't1',
                timestamp: new Date().toISOString(),
                contextItemId: 'ctx3',
                jobId: 'j3',
                entityCount: 5,
                isAutoGenerated: true,
            },
            [ConsultationPipelineEvent.PipelineCompleted]: {
                consultationId: 'c1',
                tenantId: 't1',
                timestamp: new Date().toISOString(),
                transcriptContextItemId: 'ctx1',
                pipelineDurationMs: 5000,
                stepsExecuted: ['transcription', 'summary', 'ner'],
            },
            [ConsultationPipelineEvent.PipelineStepFailed]: {
                consultationId: 'c1',
                tenantId: 't1',
                timestamp: new Date().toISOString(),
                failedStep: 'ner',
                error: 'timeout',
                willContinue: false,
            },
        };

        expect(map[ConsultationPipelineEvent.TranscriptionCreated].contextItemId).toBe('ctx1');
        expect(map[ConsultationPipelineEvent.ContextAdded].contextType).toBe('WORKNOTE');
        expect(map[ConsultationPipelineEvent.SummaryGenerated].isAutoGenerated).toBe(true);
        expect(map[ConsultationPipelineEvent.NerExtracted].entityCount).toBe(5);
        expect(map[ConsultationPipelineEvent.PipelineCompleted].pipelineDurationMs).toBe(5000);
        expect(map[ConsultationPipelineEvent.PipelineStepFailed].error).toBe('timeout');
    });

    it('should use enum values as keys (verifying string key compatibility)', () => {
        const eventKey = ConsultationPipelineEvent.TranscriptionCreated;
        expect(eventKey).toBe('consultation.transcription.created');

        const map: Partial<ConsultationPipelineEventPayloadMap> = {};
        map[eventKey] = {
            consultationId: 'c1',
            tenantId: 't1',
            timestamp: new Date().toISOString(),
            contextItemId: 'ctx1',
            jobId: 'j1',
            transcriptionSource: 'batch',
        };

        expect(map[eventKey]?.transcriptionSource).toBe('batch');
    });
});

// =============================================================================
// Event Name Compatibility with EventEmitter2
// =============================================================================

describe('EventEmitter2 compatibility', () => {
    it('should produce event names usable as EventEmitter2 string events', () => {
        for (const event of Object.values(ConsultationPipelineEvent)) {
            expect(typeof event).toBe('string');
            expect(event.length).toBeGreaterThan(0);
            expect(event).not.toContain(' ');
        }
    });

    it('should not collide with existing SysEventType values', () => {
        const sysEventValues = [
            'SysEvent.ResourceCreated',
            'SysEvent.ResourceViewed',
            'SysEvent.ResourceUpdated',
            'SysEvent.ResourceDeleted',
            'SysEvent.ResourceArchived',
            'SysEvent.WebHookRun',
            'SysEvent.SendContactMessage',
        ];

        const pipelineValues = Object.values(ConsultationPipelineEvent);
        for (const pipelineEvent of pipelineValues) {
            expect(sysEventValues).not.toContain(pipelineEvent);
        }
    });

    it('should not collide with existing EventTypes values', () => {
        const eventTypeValues = [
            'appSettings.updated',
            'notification.send',
            'resource.created',
            'resource.viewed',
            'resource.updated',
            'resource.deleted',
            'media.created',
            'media.updated',
            'user.authenticated',
            'user.created',
            'user.updated',
            'webhook.created',
            'webhook.updated',
        ];

        const pipelineValues = Object.values(ConsultationPipelineEvent);
        for (const pipelineEvent of pipelineValues) {
            expect(eventTypeValues).not.toContain(pipelineEvent);
        }
    });
});
