import { EventEmitter2 } from '@nestjs/event-emitter';
import { BaseEntity, IBaseEntity } from './base.entity';
import { DomainEvent } from '../domainEvent';

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface BaseAggregateProps extends IBaseEntity {}

export abstract class BaseAggregate extends BaseEntity {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _domainEvents: DomainEvent<any>[] = [];

  constructor(props: BaseAggregateProps) {
    super(props);
  }

  /**
   * Adds a domain event to the aggregate root.
   * @param domainEvent Event to be added.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected addEvent(domainEvent: DomainEvent<any>): void {
    this._domainEvents.push(domainEvent);
  }

  /**
   * Clears all domain events from the aggregate root.
   */
  public clearEvents(): void {
    this._domainEvents = [];
  }

  /**
   * Publishes all domain events to the event emitter.
   * @param logger Logging interface for debug messages.
   * @param eventEmitter Event emitter instance.
   */
  public async publishEvents(eventEmitter: EventEmitter2): Promise<void> {
    await Promise.all(
      this._domainEvents.map(async (event) => {
        console.log(`"${event.constructor.name}" event published for aggregate ${this.constructor.name}: ${this.id}`);
        return eventEmitter.emitAsync(event.constructor.name, event);
      }),
    );
    this.clearEvents();
  }
}
