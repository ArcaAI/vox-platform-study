/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */


import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class Webhook extends BaseTenantDataModel {
    public name: string ;
    public url: string ;
    public hashedSecret: string | null;
    public resourceTypeName: string ;
    public resourceId: string | null;
    public subscriptionMetadata: JsonValue | null;
    public resourceStatus: Enums.ResourceStatusType ;
    public resourceStatusUpdatedAt: Date | null;
    public resourceStatusUpdatedBy: string | null;
    public tags: string[] ;
    @VirtualDbProperty()
    public WebhookRunHistorys: Models.WebhookRunHistory[] | undefined;

    constructor(data: Webhook & BaseTenantDataModel) {
        super(data);
        this.name = data.name;
        this.url = data.url;
        this.hashedSecret = data.hashedSecret;
        this.resourceTypeName = data.resourceTypeName;
        this.resourceId = data.resourceId;
        this.subscriptionMetadata = data.subscriptionMetadata;
        this.resourceStatus = data.resourceStatus;
        this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
        this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
        this.tags = data.tags;
        this.WebhookRunHistorys = data.WebhookRunHistorys;
    }
}

