import {
    CreateStreamingSessionRequest,
    StreamingSessionStatus,
    StreamingAvailability,
} from './dto';

/**
 * Interface for the streaming session management service.
 *
 * This service communicates with the STT-V2 internal API to manage
 * streaming session lifecycle (create, status, finalize).
 */
export interface IStreamingSessionService {
    /**
     * Check if the STT-V2 streaming module is available and has capacity.
     */
    checkAvailability(): Promise<StreamingAvailability>;

    /**
     * Create a new streaming session on STT-V2.
     *
     * @param dto - Session creation parameters
     * @returns Session status or null if at capacity
     */
    createSession(dto: CreateStreamingSessionRequest): Promise<StreamingSessionStatus | null>;

    /**
     * Get the status of an existing streaming session.
     *
     * @param sessionId - The session identifier
     * @returns Session status or null if not found
     */
    getSessionStatus(sessionId: string): Promise<StreamingSessionStatus | null>;

    /**
     * Finalize and remove a streaming session.
     *
     * @param sessionId - The session identifier
     */
    removeSession(sessionId: string): Promise<void>;
}
