/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTaggedEntity, IBaseTaggedEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IGlobalSettingEntity extends IBaseTaggedEntity {
  name: string;
  description?: string | null;
  key: string;
  defaultValue?: string | null;
  value: string;
  locked: boolean;
  dataType: Enums.ValueType;
  namespace?: string | null;
}

export class GlobalSettingEntity extends BaseTaggedEntity {
  private _name: IGlobalSettingEntity['name'];
  private _description?: IGlobalSettingEntity['description'];
  private _key: IGlobalSettingEntity['key'];
  private _defaultValue?: IGlobalSettingEntity['defaultValue'];
  private _value: IGlobalSettingEntity['value'];
  private _locked: IGlobalSettingEntity['locked'];
  private _dataType: IGlobalSettingEntity['dataType'];
  private _namespace?: IGlobalSettingEntity['namespace'];

  constructor(init: IGlobalSettingEntity) {
    super(init);
    this._name = init.name;
    this._description = init.description;
    this._key = init.key;
    this._defaultValue = init.defaultValue;
    this._value = init.value;
    this._locked = init.locked;
    this._dataType = init.dataType;
    this._namespace = init.namespace;
  }

  get name(): IGlobalSettingEntity['name'] {
    return this._name;
  }

  set name(value: IGlobalSettingEntity['name']) {
    this.setProperty('name', value);
  }

  get description(): IGlobalSettingEntity['description'] {
    return this._description;
  }

  set description(value: IGlobalSettingEntity['description']) {
    this.setProperty('description', value);
  }

  get key(): IGlobalSettingEntity['key'] {
    return this._key;
  }

  // Phase 0 Item 2 (TASK-302 Stream A) — immutable post-construction.
  // Constructor / mapper write `_key` directly via init payload; setters
  // are the only mutation surface and they MUST refuse all writes. Any
  // attempted assignment from mass-assignment, applyChangesToEntity, or
  // ad-hoc service code is a defense-in-depth red flag.
  set key(_value: IGlobalSettingEntity['key']) {
    throw new BusinessException(
      'Phase 0 Item 2 (TASK-302): GlobalSettingEntity.key is immutable post-construction.',
    );
  }

  // Phase 0 Item 4 (TASK-302 Stream A) — @Secret marks this field for
  // audit-log scrubbing when the parent row is locked. See:
  //   packages/applications/src/services/tenant/scrubbing.ts
  @Secret()
  get defaultValue(): IGlobalSettingEntity['defaultValue'] {
    return this._defaultValue;
  }

  // Phase 0 Item 2 (TASK-302 Stream A) — immutable post-construction.
  set defaultValue(_value: IGlobalSettingEntity['defaultValue']) {
    throw new BusinessException(
      'Phase 0 Item 2 (TASK-302): GlobalSettingEntity.defaultValue is immutable post-construction.',
    );
  }

  // Phase 0 Item 4 (TASK-302 Stream A) — @Secret marks this field for
  // audit-log scrubbing when the parent row is locked.
  @Secret()
  get value(): IGlobalSettingEntity['value'] {
    return this._value;
  }

  set value(value: IGlobalSettingEntity['value']) {
    this.setProperty('value', value);
  }

  get locked(): IGlobalSettingEntity['locked'] {
    return this._locked;
  }

  // Phase 0 Item 2 (TASK-302 Stream A) — immutable post-construction.
  set locked(_value: IGlobalSettingEntity['locked']) {
    throw new BusinessException(
      'Phase 0 Item 2 (TASK-302): GlobalSettingEntity.locked is immutable post-construction.',
    );
  }

  // Phase 0 Item 2 (TASK-302 Stream A) — override BaseTenantEntity.tenantId
  // setter so that a smuggled tenantId in an update payload cannot reassign
  // the row to a different tenant. Construction-time tenantId is set via
  // the BaseTenantEntity constructor, which bypasses this override.
  override set tenantId(_value: IGlobalSettingEntity['tenantId']) {
    throw new BusinessException(
      'Phase 0 Item 2 (TASK-302): GlobalSettingEntity.tenantId is immutable post-construction.',
    );
  }

  override get tenantId(): IGlobalSettingEntity['tenantId'] {
    return super.tenantId;
  }

  get parsedValue(): any {
    if (this.dataType === Enums.ValueType.Boolean) {
      return this.value === 'true';
    } else if (this.dataType === Enums.ValueType.Integer) {
      return parseInt(this.value, 10);
    } else if (this.dataType === Enums.ValueType.Float) {
      return parseFloat(this.value);
    } else if (this.dataType === Enums.ValueType.DateTime) {
      return new Date(this.value);
    } else if (this.dataType === Enums.ValueType.Json) {
      return JSON.parse(this.value);
    } else if (this.dataType === Enums.ValueType.Array) {
      return JSON.parse(this.value);
    } else if (this.dataType === Enums.ValueType.Decimal) {
      return new Decimal(this.value);
    }
    return this.value;
  }

  get dataType(): IGlobalSettingEntity['dataType'] {
    return this._dataType;
  }

  set dataType(value: IGlobalSettingEntity['dataType']) {
    this.setProperty('dataType', value);
  }

  get namespace(): IGlobalSettingEntity['namespace'] {
    return this._namespace;
  }

  set namespace(value: IGlobalSettingEntity['namespace']) {
    this.setProperty('namespace', value);
  }

  public override validate(): void {
    if (!this._name || this._name.trim().length === 0) {
      throw new BusinessException('Global setting name is required.');
    }
    if (!this._key || this._key.trim().length === 0) {
      throw new BusinessException('Global setting key is required.');
    }
    if (this._key.length > 100) {
      throw new BusinessException('Global setting key must not exceed 100 characters.');
    }
    if (this._dataType === undefined || this._dataType === null) {
      throw new BusinessException('Global setting dataType is required.');
    }
    if (!Object.values(Enums.ValueType).includes(this._dataType)) {
      throw new BusinessException(`Global setting dataType is invalid: ${String(this._dataType)}.`);
    }
    if (typeof this._value !== 'string') {
      // Note: Prisma column is `value String` (required, non-null). The
      // tenant.service.fetchTenantConfigs masking path sets `value = ''` for
      // locked rows surfaced to non-super-admins; an empty string is therefore
      // tolerated here, but `null`/`undefined` is not.
      throw new BusinessException('Global setting value must be a string.');
    }
    if (typeof this._locked !== 'boolean') {
      throw new BusinessException('Global setting locked must be a boolean.');
    }
    if (this._namespace && this._namespace.length > 100) {
      throw new BusinessException('Global setting namespace must not exceed 100 characters.');
    }
    if (this._defaultValue && this._defaultValue.length > 4000) {
      throw new BusinessException('Global setting defaultValue must not exceed 4000 characters.');
    }
    if (this._value.length > 0) {
      this.assertValueParseable(this._dataType, this._value, 'value');
    }
    if (this._defaultValue && this._defaultValue.length > 0) {
      this.assertValueParseable(this._dataType, this._defaultValue, 'defaultValue');
    }
  }

  private assertValueParseable(dataType: Enums.ValueType, raw: string, field: string): void {
    switch (dataType) {
      case Enums.ValueType.Boolean:
        if (raw !== 'true' && raw !== 'false') {
          throw new BusinessException(`Global setting ${field} '${raw}' cannot be parsed as Boolean.`);
        }
        break;
      case Enums.ValueType.Integer: {
        const n = Number(raw);
        if (!Number.isFinite(n) || !Number.isInteger(n)) {
          throw new BusinessException(`Global setting ${field} '${raw}' cannot be parsed as Integer.`);
        }
        break;
      }
      case Enums.ValueType.Float:
      case Enums.ValueType.Double:
      case Enums.ValueType.Decimal: {
        if (!Number.isFinite(Number(raw))) {
          throw new BusinessException(`Global setting ${field} '${raw}' cannot be parsed as ${dataType}.`);
        }
        break;
      }
      case Enums.ValueType.Json:
      case Enums.ValueType.Array: {
        try {
          JSON.parse(raw);
        } catch {
          throw new BusinessException(`Global setting ${field} '${raw}' cannot be parsed as ${dataType}.`);
        }
        break;
      }
      case Enums.ValueType.Date:
      case Enums.ValueType.DateTime: {
        if (Number.isNaN(new Date(raw).getTime())) {
          throw new BusinessException(`Global setting ${field} '${raw}' cannot be parsed as ${dataType}.`);
        }
        break;
      }
      default:
        // String / Uuid / Binary / Enum / Hstore / Inet / Citext / Interval —
        // no structural parser available at the domain layer; treat the raw
        // string as-is. Format-specific validation belongs in the service layer.
        break;
    }
  }
}
