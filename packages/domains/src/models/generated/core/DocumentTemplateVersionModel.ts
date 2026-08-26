/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class DocumentTemplateVersion extends BaseTenantDataModel {
  public templateId: string;
  public versionNumber: number;
  public shape: JsonValue;
  public compiled: JsonValue;
  public compilerVersion: string;
  public checksum: string;
  public changeReason: string | null;
  @VirtualDbProperty()
  public Template: Models.DocumentTemplate | undefined;

  constructor(data: DocumentTemplateVersion & BaseTenantDataModel) {
    super(data);
    this.templateId = data.templateId;
    this.versionNumber = data.versionNumber;
    this.shape = data.shape;
    this.compiled = data.compiled;
    this.compilerVersion = data.compilerVersion;
    this.checksum = data.checksum;
    this.changeReason = data.changeReason;
    this.Template = data.Template;
  }
}
