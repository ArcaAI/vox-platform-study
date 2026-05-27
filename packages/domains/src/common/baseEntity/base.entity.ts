/* eslint-disable @typescript-eslint/no-explicit-any */
// Import directly to avoid circular dependency through barrel exports
import { ResourceStatusType } from '../../enums/generated/ResourceStatusType';
import { toObject } from '../toObject';
import { toRawObject } from '../toRawObject';

export type EntityId = string;

export interface BaseEntityFactoryCreateProps {
  resourceStatus?: ResourceStatusType;
  resourceStatusUpdatedAt?: Date;
  resourceStatusUpdatedBy?: EntityId | null;
  // createdBy?: EntityId | null;
  // updatedBy?: EntityId | null;
}

export interface IBaseEntity {
  metaData?: Record<string, any>;
  version?: number;
  id: EntityId;

  resourceStatus?: ResourceStatusType;
  resourceStatusUpdatedAt?: Date | null;
  resourceStatusUpdatedBy?: EntityId | null;

  createdBy: EntityId | null;
  updatedBy: EntityId | null;
  createdAt: Date;
  updatedAt: Date | null;
}

export abstract class BaseEntity {
  private _id: EntityId;
  private _createdBy: EntityId | null;
  private _updatedBy: EntityId | null;
  private _createdAt: Date;
  private _updatedAt: Date;
  private _resourceStatus: ResourceStatusType;
  private _resourceStatusUpdatedAt: Date | null;
  private _resourceStatusUpdatedBy: EntityId | null;
  private _version: number;
  private _changes: Record<string, any> = {};

  constructor(init: IBaseEntity) {
    this._id = init.id;
    this._createdBy = init.createdBy;
    this._updatedBy = init.updatedBy;
    this._createdAt = init.createdAt || new Date();
    this._updatedAt = init.updatedAt || new Date();
    this._resourceStatus = init.resourceStatus || ResourceStatusType.ENABLED;
    this._resourceStatusUpdatedAt = init.resourceStatusUpdatedAt || null;
    this._resourceStatusUpdatedBy = init.resourceStatusUpdatedBy || null;
    this._version = init.version ?? 1;
  }

  get id(): EntityId {
    return this._id;
  }

  get createdBy(): EntityId | null {
    return this._createdBy;
  }

  get updatedBy(): EntityId | null {
    return this._updatedBy;
  }

  set updatedBy(value: EntityId | null) {
    this.setProperty('updatedBy', value);
  }

  get createdAt(): Date {
    return this._createdAt;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  get resourceStatus(): ResourceStatusType {
    return this._resourceStatus;
  }

  get resourceStatusUpdatedAt(): Date | null {
    return this._resourceStatusUpdatedAt;
  }

  get resourceStatusUpdatedBy(): EntityId | null {
    return this._resourceStatusUpdatedBy;
  }

  /**
   * Monotonic version for optimistic concurrency control. Mapped to the
   * `_version` column on every Prisma model. Database-owned — the only
   * legitimate writer is `Repository<T>.updateWithVersion`. Exposed read-only
   * so services and mappers can round-trip it.
   *
   * @see TASK-302 Stream D Phase B
   */
  get version(): number {
    return this._version;
  }

  get archivedAt(): Date | null {
    return this.resourceStatus === ResourceStatusType.ARCHIVED ? this._resourceStatusUpdatedAt : null;
  }

  get deletedAt(): Date | null {
    return this.resourceStatus === ResourceStatusType.DELETED ? this._resourceStatusUpdatedAt : null;
  }

  get hasChanges(): boolean {
    return Object.keys(this._changes).length > 0;
  }

  get changes(): Record<string, any> {
    return this._changes;
  }

  // Check if the resource is enabled
  get isEnabled(): boolean {
    return this.resourceStatus === ResourceStatusType.ENABLED;
  }

  // Check if the resource is disabled
  get isDisabled(): boolean {
    return this.resourceStatus === ResourceStatusType.DISABLED;
  }

  // Check if the resource is archived
  get isDeleted(): boolean {
    return this.resourceStatus === ResourceStatusType.DELETED;
  }

  // Check if the resource is archived
  get isArchived(): boolean {
    return this.resourceStatus === ResourceStatusType.ARCHIVED;
  }

  /**
   * Returns the data object for marking this entity as deleted.
   * Useful for batch operations or when you need the raw update data.
   *
   * @param updatedBy - Optional user ID who performed the deletion
   * @returns Object with resourceStatus fields for persistence
   * @deprecated Use the `delete()` method instead for proper change tracking
   */
  public markAsDeleted(updatedBy?: EntityId): object {
    return {
      resourceStatus: ResourceStatusType.DELETED,
      resourceStatusUpdatedAt: new Date(),
      resourceStatusUpdatedBy: updatedBy,
    };
  }

  /**
   * Archives the resource, setting its status to `Archived`.
   *
   * @param updatedBy - (Optional) The ID of the user who performed the archive action.
   * @returns The current instance of the resource for method chaining.
   */
  public archive(updatedBy?: EntityId): this {
    this.setProperty('resourceStatus', ResourceStatusType.ARCHIVED);
    this.setProperty('resourceStatusUpdatedAt', new Date());
    if (updatedBy) {
      this.setProperty('resourceStatusUpdatedBy', updatedBy);
    }
    return this;
  }

  /**
   * Reinstates the resource from an archived state to `Disabled`.
   *
   * @param updatedBy - (Optional) The ID of the user who performed the reinstate action.
   * @returns The current instance of the resource for method chaining.
   */
  public reinstate(updatedBy?: EntityId): this {
    this.setProperty('resourceStatus', ResourceStatusType.DISABLED);
    this.setProperty('resourceStatusUpdatedAt', new Date());
    if (updatedBy) {
      this.setProperty('resourceStatusUpdatedBy', updatedBy);
    }
    return this;
  }

  /**
   * Marks the resource as deleted, setting its status to `Deleted`.
   *
   * @param updatedBy - (Optional) The ID of the user who performed the delete action.
   * @returns The current instance of the resource for method chaining.
   */
  public delete(updatedBy?: EntityId): this {
    this.setProperty('resourceStatus', ResourceStatusType.DELETED);
    this.setProperty('resourceStatusUpdatedAt', new Date());
    if (updatedBy) {
      this.setProperty('resourceStatusUpdatedBy', updatedBy);
    }
    return this;
  }

  /**
   * Recovers the resource from a deleted state to `Disabled`.
   *
   * @param updatedBy - (Optional) The ID of the user who performed the recover action.
   * @returns The current instance of the resource for method chaining.
   */
  public recoverFromDelete(updatedBy?: EntityId): this {
    this.setProperty('resourceStatus', ResourceStatusType.DISABLED);
    this.setProperty('resourceStatusUpdatedAt', new Date());
    if (updatedBy) {
      this.setProperty('resourceStatusUpdatedBy', updatedBy);
    }
    return this;
  }

  /**
   * Enables the resource, setting its status to `Enabled`.
   *
   * @param updatedBy - (Optional) The ID of the user who performed the enable action.
   * @returns The current instance of the resource for method chaining.
   */
  public enable(updatedBy?: EntityId): this {
    this.setProperty('resourceStatus', ResourceStatusType.ENABLED);
    this.setProperty('resourceStatusUpdatedAt', new Date());
    if (updatedBy) {
      this.setProperty('resourceStatusUpdatedBy', updatedBy);
    }
    return this;
  }

  /**
   * Disables the resource, setting its status to `Disabled`.
   *
   * @param updatedBy - (Optional) The ID of the user who performed the disable action.
   * @returns The current instance of the resource for method chaining.
   */
  public disable(updatedBy?: EntityId): this {
    this.setProperty('resourceStatus', ResourceStatusType.DISABLED);
    this.setProperty('resourceStatusUpdatedAt', new Date());
    if (updatedBy) {
      this.setProperty('resourceStatusUpdatedBy', updatedBy);
    }
    return this;
  }

  /**
   * Toggles the resource's status specifically between `Enabled` and `Disabled`.
   *
   * If the resource is currently `Enabled`, it will be set to `Disabled`.
   * If the resource is currently `Disabled`, it will be set to `Enabled`.
   * This function does not affect any other status states.
   *
   * @param updatedBy - (Optional) The ID of the user who performed the toggle action.
   * @returns The current instance of the resource for method chaining.
   */
  public toggleEnabledDisabled(updatedBy?: EntityId): this {
    if (this.resourceStatus === ResourceStatusType.ENABLED) {
      this.setProperty('resourceStatus', ResourceStatusType.DISABLED);
    } else if (this.resourceStatus === ResourceStatusType.DISABLED) {
      this.setProperty('resourceStatus', ResourceStatusType.ENABLED);
    }

    this.setProperty('resourceStatusUpdatedAt', new Date());
    if (updatedBy) {
      this.setProperty('resourceStatusUpdatedBy', updatedBy);
    }

    return this; // Enables method chaining
  }

  /**
   * Clears the stores changes in this entity
   *
   * @param updatedBy - (Optional) The ID of the user who performed the disable action.
   * @returns The current instance of the resource for method chaining.
   */
  public clearChanges(): this {
    this._changes = {};
    return this;
  }

  /**
   * Identity check for entities. Two entities are equal when:
   *
   *  - They share the same `id`, AND
   *  - If BOTH are `BaseTenantEntity` subclasses, they ALSO share the
   *    same `tenantId` (TASK-306 P3.4 / AC-13 / audit L-4 — tenant is
   *    part of the entity's identity, not just metadata).
   *
   * The tenant detection is intentionally duck-typed via `'_tenantId'
   * in other`: importing `BaseTenantEntity` here would create a
   * parent-child import cycle (BaseTenantEntity extends BaseAggregate
   * extends BaseEntity). TypeScript's `private` modifier compiles to a
   * plain runtime property, so `_tenantId` is always present on
   * `BaseTenantEntity` instances and absent on every other
   * `BaseEntity` subclass — making the `in` check a safe structural
   * proxy for `instanceof BaseTenantEntity`. Note this also drops the
   * pre-W5.5.5 `constructor !== this.constructor` strict-class check;
   * that check excluded "comparing a tenant entity with a non-tenant
   * entity of same id" cases that AC-13 explicitly requires to fall
   * through to id-only equality.
   */
  public equals(object: BaseEntity | null): boolean {
    if (object == null) {
      return false;
    }
    if (this === object) {
      return true;
    }
    if (object.id !== this.id) {
      return false;
    }
    const thisHasTenant = '_tenantId' in this;
    const otherHasTenant = '_tenantId' in (object as object);
    if (thisHasTenant && otherHasTenant) {
      const thisTenantId = (this as unknown as { tenantId: EntityId }).tenantId;
      const otherTenantId = (object as unknown as { tenantId: EntityId }).tenantId;
      return thisTenantId === otherTenantId;
    }
    return true;
  }

  /**
   * Converts the instance of a class to a plain object.
   * This method iterates over the properties of the instance,
   * applies a conversion function to each property's value,
   * and returns a new object with the same property names and values.
   * The returned object is immutable.
   */
  public toRawObject(): object {
    return toRawObject(this);
  }

  /**
   * Converts the instance of a class to a plain object.
   * This method iterates over the properties of the instance,
   * removes leading underscores from property names,
   * applies a conversion function to each property's value,
   * and returns a new object with the modified property names and values.
   * The returned object is immutable.
   */
  public toObject(): object {
    return toObject(this);
  }

  /**
   * Converts the instance of a class to a JSON string. (Used by JSON.stringify)
   * @returns A JSON string representing the object.
   */
  public toJSON() {
    return this.toObject();
  }

  /**
   * Sets the value of a property on the instance and tracks changes.
   * This method takes a property name and a value as parameters.
   * It stores the value in a property with a leading underscore,
   * and if the new value is different from the current value,
   * it also updates a `changes` object to track the change.
   *
   * @param propertyName - The name of the property to set (without the leading underscore).
   * @param value - The new value to assign to the property.
   */
  protected setProperty<T>(propertyName: string, value: T): void {
    // Create the internal property name with a leading underscore
    const internalPropertyName = `_${propertyName}`;

    // Get the current value of the internal property
    const currentValue = (this as any)[internalPropertyName];

    // Check if the current value is different from the new value
    if (!Object.is(currentValue, value)) {
      // Set the new value to the internal property
      (this as any)[internalPropertyName] = value;

      // Track the change by updating the changes object
      this._changes[propertyName] = value;
    }
  }

  protected getProperty(propertyName: string) {
    return this._changes[propertyName];
  }

  /**
   * Adds a change entity to a property that is an array, or initializes the property as an array if it is undefined.
   * @param propertyName - The name of the property to add to (without the leading underscore).
   * @param value - The value to add to the property.
   */
  protected addProperty<T>(propertyName: string, value: T): any {
    const propertyChanges = this.getProperty(propertyName);
    if (!propertyChanges) {
      this.setProperty(propertyName, [value]);
      return;
    }
    this.setProperty(propertyName, [...this.getProperty(propertyName), value]);
  }

  public abstract validate(): void;
}
