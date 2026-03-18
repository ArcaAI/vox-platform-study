/* eslint-disable @typescript-eslint/no-explicit-any */
export class BaseDataModel {
    public metaData: Record<string, any> | null;
    public version: number | null;
    public id: string;
    public createdBy: string | null;
    public updatedBy: string | null;
    public createdAt: Date;
    public updatedAt: Date;

    constructor(init: BaseDataModel) {
        this.metaData = init.metaData ?? null;
        this.version = init.version ?? null;
        this.id = init.id;
        this.createdBy = init.createdBy;
        this.updatedBy = init.updatedBy;
        this.createdAt = init.createdAt;
        this.updatedAt = init.updatedAt;
    }
}
