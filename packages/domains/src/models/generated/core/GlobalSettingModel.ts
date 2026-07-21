/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class GlobalSetting extends BaseTenantDataModel {
  public locked: boolean;
  public name: string;
  public description: string | null;
  public key: string;
  public defaultValue: string | null;
  public value: string;
  // Vault-Transit-encrypted ciphertext + Transit key version.
  public encryptedValue: Uint8Array | null;
  public keyVersion: number | null;
  public dataType: Enums.ValueType;
  public namespace: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public tags: string[];

  constructor(data: GlobalSetting & BaseTenantDataModel) {
    super(data);
    this.locked = data.locked;
    this.name = data.name;
    this.description = data.description;
    this.key = data.key;
    this.defaultValue = data.defaultValue;
    this.value = data.value;
    this.encryptedValue = data.encryptedValue;
    this.keyVersion = data.keyVersion;
    this.dataType = data.dataType;
    this.namespace = data.namespace;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.tags = data.tags;
  }
}
