/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ConsultationContextSchemaVersion extends BaseTenantDataModel {
  public schemaId: string;
  public versionNumber: number;
  public definition: JsonValue;
  public checksum: string;
  public changeReason: string | null;
  @VirtualDbProperty()
  public Schema: Models.ConsultationContextSchema | undefined;

  constructor(data: ConsultationContextSchemaVersion & BaseTenantDataModel) {
    super(data);
    this.schemaId = data.schemaId;
    this.versionNumber = data.versionNumber;
    this.definition = data.definition;
    this.checksum = data.checksum;
    this.changeReason = data.changeReason;
    this.Schema = data.Schema;
  }
}
