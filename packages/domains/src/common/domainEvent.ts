import { convertPropsToObject, generateId } from '../utils';

type DomainEventMetaData = {
    /** Timestamp when this domain event occurred */
    readonly timestamp: number;

    /** ID for correlation purposes (for Integration Events,logs correlation, etc).
     */
    readonly correlationId: string;

    /**
     * Causation id used to reconstruct execution order if needed
     */
    readonly causationId: string | null;

    /**
     * User ID for debugging and logging purposes
     */
    readonly responsibleUserId: string | null;
};

export interface BaseDomainEventProps<T> {
    id?: string;
    entityId?: string | null;
    correlationId?: string | null;
    causationId?: string | null;
    responsibleUserId?: string | null;
    createdAt?: Date;
    metadata?: DomainEventMetaData | null;
    domain: string;
    props: T;
}

export abstract class DomainEvent<DomainEventProps> {
    private readonly _id: string;
    private readonly _entityId: string | null;
    private readonly _metadata: DomainEventMetaData;
    private readonly _domain: string;
    private readonly props: DomainEventProps;

    constructor({
        entityId,
        correlationId,
        causationId,
        responsibleUserId,
        createdAt,
        props,
        domain
    }: BaseDomainEventProps<DomainEventProps>) {
        this._id = generateId();
        this._entityId = entityId || null;
        this._domain = domain;
        this.props = this.freezeProps(props);

        this._metadata = {
            correlationId: correlationId || generateId(),
            causationId: causationId || null,
            timestamp: createdAt?.getTime() || Date.now(),
            responsibleUserId: responsibleUserId || null
        };
    }

    private freezeProps(props: DomainEventProps): DomainEventProps {
        return Object.freeze(props);
    }

    public getProps(): Omit<BaseDomainEventProps<DomainEventProps>, 'props'> &
        DomainEventProps {
        return Object.freeze({
            id: this._id,
            entityId: this._entityId,
            metadata: {
                timestamp: this._metadata.timestamp,
                correlationId: this._metadata.correlationId,
                causationId: this._metadata.causationId,
                responsibleUserId: this._metadata.responsibleUserId
            },
            domain: this._domain,
            ...this.props
        });
    }

    public toObject(): BaseDomainEventProps<DomainEventProps> {
        return Object.freeze({
            id: this._id,
            entityId: this._entityId,
            metadata: {
                timestamp: this._metadata.timestamp,
                correlationId: this._metadata.correlationId,
                causationId: this._metadata.causationId,
                responsibleUserId: this._metadata.responsibleUserId
            },
            domain: this._domain,
            ...convertPropsToObject(this.props)
        });
    }
}
