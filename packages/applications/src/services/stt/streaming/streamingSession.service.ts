import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { IStreamingSessionService } from './IStreamingSessionService';
import {
    CreateStreamingSessionRequest,
    StreamingSessionStatus,
    StreamingAvailability,
} from './dto';
import { IConfigService } from '../../baseServices/_meta/config';

/**
 * StreamingSessionService
 *
 * Manages streaming session lifecycle by communicating with the STT-V2
 * internal API endpoints:
 * - GET  /internal/streaming/availability
 * - POST /internal/streaming/sessions
 * - GET  /internal/streaming/sessions/{sessionId}
 * - DELETE /internal/streaming/sessions/{sessionId}
 *
 * This is a brand-new service for STT-V2 WebSocket streaming.
 * It does NOT touch or reuse the old STT v1 WebSocket implementation.
 */
@Injectable()
export class StreamingSessionService implements IStreamingSessionService {
    private readonly logger = new Logger(StreamingSessionService.name);
    private readonly sttBaseUrl: string;

    constructor(
        private readonly httpService: HttpService,
        @Optional() @Inject(IConfigService) private readonly configService?: IConfigService,
    ) {
        this.sttBaseUrl = this.configService?.config?.STT_V2_URL || 'http://localhost:8861';
        this.logger.log({
            message: 'StreamingSessionService initialized',
            sttBaseUrl: this.sttBaseUrl,
        });
    }

    /**
     * Check if the STT-V2 streaming module is available and has capacity.
     */
    async checkAvailability(): Promise<StreamingAvailability> {
        try {
            const { data } = await firstValueFrom(
                this.httpService.get<StreamingAvailability>(
                    `${this.sttBaseUrl}/internal/streaming/availability`,
                    { timeout: 5000 },
                ),
            );
            return data;
        } catch (error) {
            this.logger.warn({
                message: 'Failed to check streaming availability',
                error: error instanceof Error ? error.message : String(error),
            });
            return {
                available: false,
                status: 'unreachable',
                maxConcurrent: 0,
                currentActive: 0,
                availableSlots: 0,
            };
        }
    }

    /**
     * Create a new streaming session on STT-V2.
     *
     * @returns Session status, or null if at capacity (503)
     */
    async createSession(
        dto: CreateStreamingSessionRequest,
    ): Promise<StreamingSessionStatus | null> {
        try {
            const { data } = await firstValueFrom(
                this.httpService.post<StreamingSessionStatus>(
                    `${this.sttBaseUrl}/internal/streaming/sessions`,
                    {
                        session_id: dto.sessionId,
                        tenant_id: dto.tenantId,
                        pipeline_id: dto.pipelineId,
                        consultation_id: dto.consultationId,
                        sample_rate: dto.sampleRate ?? 16000,
                        microphone_id: dto.microphoneId,
                        language: dto.language ?? null,
                        code_switching: dto.codeSwitching ?? null,
                        diarization: dto.diarization ?? null,
                    },
                    { timeout: 15000 },
                ),
            );

            this.logger.log({
                message: 'Streaming session created',
                sessionId: dto.sessionId,
                status: data.status,
            });

            return {
                sessionId: data.sessionId ?? (data as any).session_id,
                status: data.status,
                reason: data.reason,
                maxConcurrent: data.maxConcurrent ?? (data as any).max_concurrent,
                currentActive: data.currentActive ?? (data as any).current_active,
            };
        } catch (error: any) {
            // 503 = at capacity → return null (not an error)
            if (error?.response?.status === 503) {
                this.logger.warn({
                    message: 'STT-V2 streaming at capacity',
                    sessionId: dto.sessionId,
                    detail: error.response?.data?.detail,
                });
                return null;
            }

            this.logger.error({
                message: 'Failed to create streaming session',
                sessionId: dto.sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    /**
     * Get the status of an existing streaming session.
     */
    async getSessionStatus(sessionId: string): Promise<StreamingSessionStatus | null> {
        try {
            const { data } = await firstValueFrom(
                this.httpService.get<StreamingSessionStatus>(
                    `${this.sttBaseUrl}/internal/streaming/sessions/${sessionId}`,
                    { timeout: 5000 },
                ),
            );

            return {
                sessionId: data.sessionId ?? (data as any).session_id,
                status: data.status,
                reason: data.reason,
                maxConcurrent: data.maxConcurrent ?? (data as any).max_concurrent,
                currentActive: data.currentActive ?? (data as any).current_active,
            };
        } catch (error: any) {
            if (error?.response?.status === 404) {
                return null;
            }
            throw error;
        }
    }

    /**
     * Remove a streaming session (triggers finalization on STT-V2).
     */
    async removeSession(sessionId: string): Promise<void> {
        try {
            await firstValueFrom(
                this.httpService.delete(
                    `${this.sttBaseUrl}/internal/streaming/sessions/${sessionId}`,
                    { timeout: 10000 },
                ),
            );

            this.logger.log({
                message: 'Streaming session removed',
                sessionId,
            });
        } catch (error: any) {
            if (error?.response?.status === 404) {
                this.logger.debug({
                    message: 'Session already removed',
                    sessionId,
                });
                return;
            }
            throw error;
        }
    }
}
