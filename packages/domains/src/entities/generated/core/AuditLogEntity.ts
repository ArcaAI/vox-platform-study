/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IAuditLogEntity extends IBaseTenantEntity {
    responsibleUserId?: string | null;
    responsibleIp?: string | null;
    resourceType: Enums.ResourceType;
    resourceId?: string | null;
    resourceDatabase?: string | null;
    correlationId?: string | null;
    causationId?: string | null;
    action: Enums.AuditAction;
    eventType?: string | null;
    success?: boolean | null;
    data: JsonValue;
    previousData: JsonValue;
    metadata?: JsonValue | null;
}

export class AuditLogEntity extends BaseTenantEntity {
    private _responsibleUserId?: IAuditLogEntity['responsibleUserId'];
    private _responsibleIp?: IAuditLogEntity['responsibleIp'];
    private _resourceType: IAuditLogEntity['resourceType'];
    private _resourceId?: IAuditLogEntity['resourceId'];
    private _resourceDatabase?: IAuditLogEntity['resourceDatabase'];
    private _correlationId?: IAuditLogEntity['correlationId'];
    private _causationId?: IAuditLogEntity['causationId'];
    private _action: IAuditLogEntity['action'];
    private _eventType?: IAuditLogEntity['eventType'];
    private _success?: IAuditLogEntity['success'];
    private _data: IAuditLogEntity['data'];
    private _previousData: IAuditLogEntity['previousData'];
    private _metadata?: IAuditLogEntity['metadata'];

    constructor(init: IAuditLogEntity) {
        super(init);
        this._responsibleUserId = init.responsibleUserId;
        this._responsibleIp = init.responsibleIp;
        this._resourceType = init.resourceType;
        this._resourceId = init.resourceId;
        this._resourceDatabase = init.resourceDatabase;
        this._correlationId = init.correlationId;
        this._causationId = init.causationId;
        this._action = init.action;
        this._eventType = init.eventType;
        this._success = init.success;
        this._data = init.data;
        this._previousData = init.previousData;
        this._metadata = init.metadata;
    }

    get responsibleUserId(): IAuditLogEntity['responsibleUserId'] {
        return this._responsibleUserId;
    }

    set responsibleUserId(value: IAuditLogEntity['responsibleUserId']) {
        this.setProperty('responsibleUserId', value);
    }

    get responsibleIp(): IAuditLogEntity['responsibleIp'] {
        return this._responsibleIp;
    }

    set responsibleIp(value: IAuditLogEntity['responsibleIp']) {
        this.setProperty('responsibleIp', value);
    }

    get resourceType(): IAuditLogEntity['resourceType'] {
        return this._resourceType;
    }

    set resourceType(value: IAuditLogEntity['resourceType']) {
        this.setProperty('resourceType', value);
    }

    get resourceId(): IAuditLogEntity['resourceId'] {
        return this._resourceId;
    }

    set resourceId(value: IAuditLogEntity['resourceId']) {
        this.setProperty('resourceId', value);
    }

    get resourceDatabase(): IAuditLogEntity['resourceDatabase'] {
        return this._resourceDatabase;
    }

    set resourceDatabase(value: IAuditLogEntity['resourceDatabase']) {
        this.setProperty('resourceDatabase', value);
    }

    get correlationId(): IAuditLogEntity['correlationId'] {
        return this._correlationId;
    }

    set correlationId(value: IAuditLogEntity['correlationId']) {
        this.setProperty('correlationId', value);
    }

    get causationId(): IAuditLogEntity['causationId'] {
        return this._causationId;
    }

    set causationId(value: IAuditLogEntity['causationId']) {
        this.setProperty('causationId', value);
    }

    get action(): IAuditLogEntity['action'] {
        return this._action;
    }

    set action(value: IAuditLogEntity['action']) {
        this.setProperty('action', value);
    }

    get eventType(): IAuditLogEntity['eventType'] {
        return this._eventType;
    }

    set eventType(value: IAuditLogEntity['eventType']) {
        this.setProperty('eventType', value);
    }

    get success(): IAuditLogEntity['success'] {
        return this._success;
    }

    set success(value: IAuditLogEntity['success']) {
        this.setProperty('success', value);
    }

    get data(): IAuditLogEntity['data'] {
        return this._data;
    }

    set data(value: IAuditLogEntity['data']) {
        this.setProperty('data', value);
    }

    get previousData(): IAuditLogEntity['previousData'] {
        return this._previousData;
    }

    set previousData(value: IAuditLogEntity['previousData']) {
        this.setProperty('previousData', value);
    }

    get metadata(): IAuditLogEntity['metadata'] {
        return this._metadata;
    }

    set metadata(value: IAuditLogEntity['metadata']) {
        this.setProperty('metadata', value);
    }

    public override validate(): void {
        throw new BusinessException('Method not implemented.');
    }
}