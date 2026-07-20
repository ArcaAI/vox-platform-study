import { EventEmitter2 } from '@nestjs/event-emitter';
import { BaseEntity, IBaseEntity } from './base.entity';
import { DomainEvent } from '../domainEvent';

export type BaseAggregateProps = IBaseEntity;

export abstract class BaseAggregate extends BaseEntity {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- holds domain events of heterogeneous concrete prop types across every aggregate subclass; DomainEvent's generic parameter isn't variance-annotated, so `unknown` would reject assigning any concrete DomainEvent<X> into this array
  private _domainEvents: DomainEvent<any>[] = [];

  constructor(props: BaseAggregateProps) {
    super(props);
  }

  /**
   * Adds a domain event to the aggregate root.
   * @param domainEvent Event to be added.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts a DomainEvent of any concrete prop type, same reason as the `_domainEvents` field above
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
