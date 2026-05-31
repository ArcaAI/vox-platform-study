import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { StorageProviderType, StorageTopologyType } from '../../../enums';

export interface ITenantStorageConfigEntity extends IBaseTenantEntity {
  bucketId?: string | null;
  provider: StorageProviderType;
  topology: StorageTopologyType;
  endpoint?: string | null;
  region?: string | null;
  forcePathStyle?: boolean | null;
  accountName?: string | null;
  endpointSuffix?: string | null;
  containerPrefix?: string | null;
  credentialsRef?: string | null;
}

export class TenantStorageConfigEntity extends BaseTenantEntity {
  private _bucketId?: string | null;
  private _provider: StorageProviderType;
  private _topology: StorageTopologyType;
  private _endpoint?: string | null;
  private _region?: string | null;
  private _forcePathStyle?: boolean | null;
  private _accountName?: string | null;
  private _endpointSuffix?: string | null;
  private _containerPrefix?: string | null;
  private _credentialsRef?: string | null;

  constructor(init: ITenantStorageConfigEntity) {
    super(init);
    this._bucketId = init.bucketId;
    this._provider = init.provider;
    this._topology = init.topology;
    this._endpoint = init.endpoint;
    this._region = init.region;
    this._forcePathStyle = init.forcePathStyle;
    this._accountName = init.accountName;
    this._endpointSuffix = init.endpointSuffix;
    this._containerPrefix = init.containerPrefix;
    this._credentialsRef = init.credentialsRef;
  }

  get bucketId(): string | null | undefined {
    return this._bucketId;
  }

  set bucketId(value: string | null | undefined) {
    this.setProperty('bucketId', value);
  }

  get provider(): StorageProviderType {
    return this._provider;
  }

  set provider(value: StorageProviderType) {
    this.setProperty('provider', value);
  }

  get topology(): StorageTopologyType {
    return this._topology;
  }

  set topology(value: StorageTopologyType) {
    this.setProperty('topology', value);
  }

  get endpoint(): string | null | undefined {
    return this._endpoint;
  }

  set endpoint(value: string | null | undefined) {
    this.setProperty('endpoint', value);
  }

  get region(): string | null | undefined {
    return this._region;
  }

  set region(value: string | null | undefined) {
    this.setProperty('region', value);
  }

  get forcePathStyle(): boolean | null | undefined {
    return this._forcePathStyle;
  }

  set forcePathStyle(value: boolean | null | undefined) {
    this.setProperty('forcePathStyle', value);
  }

  get accountName(): string | null | undefined {
    return this._accountName;
  }

  set accountName(value: string | null | undefined) {
    this.setProperty('accountName', value);
  }

  get endpointSuffix(): string | null | undefined {
    return this._endpointSuffix;
  }

  set endpointSuffix(value: string | null | undefined) {
    this.setProperty('endpointSuffix', value);
  }

  get containerPrefix(): string | null | undefined {
    return this._containerPrefix;
  }

  set containerPrefix(value: string | null | undefined) {
    this.setProperty('containerPrefix', value);
  }

  get credentialsRef(): string | null | undefined {
    return this._credentialsRef;
  }

  set credentialsRef(value: string | null | undefined) {
    this.setProperty('credentialsRef', value);
  }

  /** True when this config defers to the platform/global storage configuration. */
  get isShared(): boolean {
    return this._topology === StorageTopologyType.SHARED;
  }

  /** True when this row is the tenant-wide default (not a per-bucket override). */
  get isTenantDefault(): boolean {
    return this._bucketId === null || this._bucketId === undefined;
  }

  public override validate(): void {
    super.validate();
    if (!this._provider) {
      throw new Error('Storage provider is required');
    }
    if (this._topology === StorageTopologyType.DEDICATED && !this._credentialsRef) {
      throw new Error('credentialsRef is required for a DEDICATED storage configuration');
    }
  }
}
