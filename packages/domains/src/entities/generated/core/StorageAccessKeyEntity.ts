import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';

export interface IStorageAccessKeyEntity extends IBaseTenantEntity {
  name: string;
  description?: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  permissions: string[];
  bucketIds: string[];
  expiresAt?: Date | null;
  lastUsedAt?: Date | null;
  lastUsedIp?: string | null;
}

export class StorageAccessKeyEntity extends BaseTenantEntity {
  private _name: string;
  private _description?: string | null;
  private _accessKeyId: string;
  private _secretAccessKey: string;
  private _permissions: string[];
  private _bucketIds: string[];
  private _expiresAt?: Date | null;
  private _lastUsedAt?: Date | null;
  private _lastUsedIp?: string | null;

  constructor(init: IStorageAccessKeyEntity) {
    super(init);
    this._name = init.name;
    this._description = init.description;
    this._accessKeyId = init.accessKeyId;
    this._secretAccessKey = init.secretAccessKey;
    this._permissions = init.permissions;
    this._bucketIds = init.bucketIds;
    this._expiresAt = init.expiresAt;
    this._lastUsedAt = init.lastUsedAt;
    this._lastUsedIp = init.lastUsedIp;
  }

  get name(): string {
    return this._name;
  }
  set name(value: string) {
    this.setProperty('name', value);
  }

  get description(): string | null | undefined {
    return this._description;
  }
  set description(value: string | null | undefined) {
    this.setProperty('description', value);
  }

  get accessKeyId(): string {
    return this._accessKeyId;
  }
  set accessKeyId(value: string) {
    this.setProperty('accessKeyId', value);
  }

  // The persisted value is a HASH of the secret, but it is
  // still marked @Secret so it is redacted from audit-log surfaces (the raw
  // plaintext is only ever returned once at creation and never stored).
  @Secret()
  get secretAccessKey(): string {
    return this._secretAccessKey;
  }
  set secretAccessKey(value: string) {
    this.setProperty('secretAccessKey', value);
  }

  get permissions(): string[] {
    return this._permissions;
  }
  set permissions(value: string[]) {
    this.setProperty('permissions', value);
  }

  get bucketIds(): string[] {
    return this._bucketIds;
  }
  set bucketIds(value: string[]) {
    this.setProperty('bucketIds', value);
  }

  get expiresAt(): Date | null | undefined {
    return this._expiresAt;
  }
  set expiresAt(value: Date | null | undefined) {
    this.setProperty('expiresAt', value);
  }

  get lastUsedAt(): Date | null | undefined {
    return this._lastUsedAt;
  }
  set lastUsedAt(value: Date | null | undefined) {
    this.setProperty('lastUsedAt', value);
  }

  get lastUsedIp(): string | null | undefined {
    return this._lastUsedIp;
  }
  set lastUsedIp(value: string | null | undefined) {
    this.setProperty('lastUsedIp', value);
  }

  get isExpired(): boolean {
    if (!this._expiresAt) return false;
    return this._expiresAt < new Date();
  }

  hasPermission(permission: string): boolean {
    return this._permissions.includes(permission);
  }

  hasBucketAccess(bucketId: string): boolean {
    if (this._bucketIds.length === 0) return true;
    return this._bucketIds.includes(bucketId);
  }

  public override validate(): void {
    super.validate();
    if (!this._name) throw new Error('Key name is required');
    if (!this._accessKeyId) throw new Error('Access key ID is required');
    if (!this._secretAccessKey) throw new Error('Secret access key is required');
  }
}
