/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Models from './';

export class NamedEntity extends BaseTenantDataModel {
  public contextItemId: string;
  public text: string;
  public className: string;
  public normalizedText: string | null;
  public startOffset: number | null;
  public endOffset: number | null;
  public confidence: number | null;
  public aiModelId: string | null;
  public aiModelVersion: string | null;
  public processingTimeMs: number | null;
  public metadata: JsonValue | null;

  constructor(data: NamedEntity & BaseTenantDataModel) {
    super(data);
    this.contextItemId = data.contextItemId;
    this.text = data.text;
    this.className = data.className;
    this.normalizedText = data.normalizedText;
    this.startOffset = data.startOffset;
    this.endOffset = data.endOffset;
    this.confidence = data.confidence;
    this.aiModelId = data.aiModelId;
    this.aiModelVersion = data.aiModelVersion;
    this.processingTimeMs = data.processingTimeMs;
    this.metadata = data.metadata;
  }
}
