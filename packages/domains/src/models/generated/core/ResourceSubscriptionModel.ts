/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */


import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ResourceSubscription extends BaseTenantDataModel {
    public resourceId: string | null;
    public resourceTypeName: string | null;
    public subscriptionType: Enums.ResourceSubscriptionType ;
    public targetUserId: string ;
    public subscriptionMetadata: JsonValue | null;
    public resourceStatus: Enums.ResourceStatusType ;
    public resourceStatusUpdatedAt: Date | null;
    public resourceStatusUpdatedBy: string | null;
    public tags: string[] ;
    @VirtualDbProperty()
    public Subscribers: Models.User[] | undefined;
    @VirtualDbProperty()
    public Notifications: Models.Notification[] | undefined;

    constructor(data: ResourceSubscription & BaseTenantDataModel) {
        super(data);
        this.resourceId = data.resourceId;
        this.resourceTypeName = data.resourceTypeName;
        this.subscriptionType = data.subscriptionType;
        this.targetUserId = data.targetUserId;
        this.subscriptionMetadata = data.subscriptionMetadata;
        this.resourceStatus = data.resourceStatus;
        this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
        this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
        this.tags = data.tags;
        this.Subscribers = data.Subscribers;
        this.Notifications = data.Notifications;
    }
}

