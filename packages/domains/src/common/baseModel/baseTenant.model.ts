import * as Models from './base.model';

export class BaseTenantDataModel extends Models.BaseDataModel {
    public tenantId: string | null;

    constructor(init: BaseTenantDataModel) {
        super(init);
        this.tenantId = init.tenantId;
    }
}
