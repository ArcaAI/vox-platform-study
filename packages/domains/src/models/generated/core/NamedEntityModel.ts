/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class NamedEntity extends BaseTenantDataModel {
  public contextItemId: string;
  public text: string;
  public className: string;
  public normalizedText: string | null;
  // TASK-330 Phase 1 — clinical ontology normalization codes
  public umlsCui: string | null;
  public snomedCode: string | null;
  public rxnormCode: string | null;
  public icdCode: string | null;
  public loincCode: string | null;
  // TASK-330 Phase 1 — transcript-span provenance
  public transcriptContextItemId: string | null;
  public transcriptStartOffset: number | null;
  public transcriptEndOffset: number | null;
  public startOffset: number | null;
  public endOffset: number | null;
  public confidence: number | null;
  public aiModelId: string | null;
  public aiModelVersion: string | null;
  public processingTimeMs: number | null;
  public metadata: JsonValue | null;
  // TASK-369 Phase 3C — Vault-Transit ciphertext columns + shared key version.
  public encryptedText: Uint8Array | null;
  public encryptedNormalizedText: Uint8Array | null;
  public encryptedMetadata: Uint8Array | null;
  public keyVersion: number | null;
  @VirtualDbProperty()
  public ContextItem: Models.ContextItem | undefined;
  @VirtualDbProperty()
  public TranscriptContextItem: Models.ContextItem | undefined;

  constructor(data: NamedEntity & BaseTenantDataModel) {
    super(data);
    this.contextItemId = data.contextItemId;
    this.text = data.text;
    this.className = data.className;
    this.normalizedText = data.normalizedText;
    this.umlsCui = data.umlsCui;
    this.snomedCode = data.snomedCode;
    this.rxnormCode = data.rxnormCode;
    this.icdCode = data.icdCode;
    this.loincCode = data.loincCode;
    this.transcriptContextItemId = data.transcriptContextItemId;
    this.transcriptStartOffset = data.transcriptStartOffset;
    this.transcriptEndOffset = data.transcriptEndOffset;
    this.startOffset = data.startOffset;
    this.endOffset = data.endOffset;
    this.confidence = data.confidence;
    this.aiModelId = data.aiModelId;
    this.aiModelVersion = data.aiModelVersion;
    this.processingTimeMs = data.processingTimeMs;
    this.metadata = data.metadata;
    this.encryptedText = data.encryptedText;
    this.encryptedNormalizedText = data.encryptedNormalizedText;
    this.encryptedMetadata = data.encryptedMetadata;
    this.keyVersion = data.keyVersion;
    this.ContextItem = data.ContextItem;
    this.TranscriptContextItem = data.TranscriptContextItem;
  }
}
