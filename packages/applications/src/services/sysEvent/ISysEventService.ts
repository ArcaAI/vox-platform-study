import { SysEvent, SendContactMessageEvent } from '@arcaai/domains';

/**
 * Interface for the System Event Service.
 * Handles system-wide events and queues jobs for async processing.
 */
export interface ISysEventService {
    /**
     * Handle the event when a resource is created.
     * Queues audit log, user activity, and system event jobs in parallel.
     */
    handleResourceCreatedEvent(event: SysEvent): Promise<void>;

    /**
     * Handle the event when a resource is viewed.
     * Queues audit log, user activity, and system event jobs in parallel.
     */
    handleResourceViewedEvent(event: SysEvent): Promise<void>;

    /**
     * Handle the event when a resource is updated.
     * Queues audit log, user activity, and system event jobs in parallel.
     */
    handleResourceUpdatedEvent(event: SysEvent): Promise<void>;

    /**
     * Handle the event when a resource is deleted.
     * Queues audit log, user activity, and system event jobs in parallel.
     */
    handleResourceDeletedEvent(event: SysEvent): Promise<void>;

    /**
     * Handle the event when a resource is archived.
     * Queues audit log, user activity, and system event jobs in parallel.
     */
    handleResourceArchivedEvent(event: SysEvent): Promise<void>;

    /**
     * Handle the event when a contact message is sent.
     * Queues email/SMS, audit log, and user activity jobs in parallel.
     */
    handleSendContactMessageEvent(event: SendContactMessageEvent): Promise<void>;
}

export const ISysEventService = Symbol('ISysEventService');
