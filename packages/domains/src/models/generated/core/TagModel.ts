/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */


import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class Tag extends BaseTenantDataModel {
    public resourceTypeName: string | null;
    public resourceId: string | null;
    public tagKey: string | null;
    public tagValue: string ;
    public description: string | null;
    public color: string | null;
    public icon: string | null;
    public resourceStatus: Enums.ResourceStatusType ;
    public resourceStatusUpdatedAt: Date | null;
    public resourceStatusUpdatedBy: string | null;

    constructor(data: Tag & BaseTenantDataModel) {
        super(data);
        this.resourceTypeName = data.resourceTypeName;
        this.resourceId = data.resourceId;
        this.tagKey = data.tagKey;
        this.tagValue = data.tagValue;
        this.description = data.description;
        this.color = data.color;
        this.icon = data.icon;
        this.resourceStatus = data.resourceStatus;
        this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
        this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    }
}

