import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { TenantBucketPurpose, TenantBucketType } from '../../../enums';

export interface ITenantBucketEntity extends IBaseTenantEntity {
  name: string;
  slug: string;
  description?: string | null;
  bucketType: TenantBucketType;
  purpose?: TenantBucketPurpose;
  pathPattern: string;
  quotaBytes?: bigint | null;
}

export class TenantBucketEntity extends BaseTenantEntity {
  private _name: string;
  private _slug: string;
  private _description?: string | null;
  private _bucketType: TenantBucketType;
  private _purpose: TenantBucketPurpose;
  private _pathPattern: string;
  private _quotaBytes?: bigint | null;

  constructor(init: ITenantBucketEntity) {
    super(init);
    this._name = init.name;
    this._slug = init.slug;
    this._description = init.description;
    this._bucketType = init.bucketType;
    this._purpose = init.purpose ?? TenantBucketPurpose.CUSTOM;
    this._pathPattern = init.pathPattern;
    this._quotaBytes = init.quotaBytes ?? null;
  }

  get name(): string {
    return this._name;
  }

  set name(value: string) {
    this.setProperty('name', value);
  }

  get slug(): string {
    return this._slug;
  }

  set slug(value: string) {
    this.setProperty('slug', value);
  }

  get description(): string | null | undefined {
    return this._description;
  }

  set description(value: string | null | undefined) {
    this.setProperty('description', value);
  }

  get bucketType(): TenantBucketType {
    return this._bucketType;
  }

  set bucketType(value: TenantBucketType) {
    this.setProperty('bucketType', value);
  }

  get purpose(): TenantBucketPurpose {
    return this._purpose;
  }

  set purpose(value: TenantBucketPurpose) {
    this.setProperty('purpose', value);
  }

  get pathPattern(): string {
    return this._pathPattern;
  }

  set pathPattern(value: string) {
    this.setProperty('pathPattern', value);
  }

  get quotaBytes(): bigint | null | undefined {
    return this._quotaBytes;
  }

  set quotaBytes(value: bigint | null | undefined) {
    this.setProperty('quotaBytes', value);
  }

  get isSystemBucket(): boolean {
    return this._bucketType === TenantBucketType.SYSTEM;
  }

  public override validate(): void {
    super.validate();
    if (!this._name) {
      throw new Error('Bucket name is required');
    }
    if (!this._slug) {
      throw new Error('Bucket slug is required');
    }
  }
}
