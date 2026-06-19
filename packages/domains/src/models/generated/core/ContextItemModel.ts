/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ContextItem extends BaseTenantDataModel {
  public consultationId: string;
  public type: Enums.ContextItemType;
  public source: Enums.ContextItemSource;
  public currentVersionNumber: number;
  public content: string | null;
  // TASK-369 Phase 3B — Vault-Transit ciphertext of `content` + Transit key version.
  public encryptedContent: Uint8Array | null;
  public contentKeyVersion: number | null;
  public mediaId: string | null;
  public dnaWritingStyleId: string | null;
  public qdrantSynced: boolean;
  public qdrantSyncedAt: Date | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public Consultation: Models.Consultation | undefined;
  @VirtualDbProperty()
  public AudioRecordings: Models.AudioRecording[] | undefined;
  @VirtualDbProperty()
  public SummaryMeta: Models.SummaryMeta | undefined;
  @VirtualDbProperty()
  public NamedEntities: Models.NamedEntity[] | undefined;
  @VirtualDbProperty()
  public Versions: Models.ContextItemVersion[] | undefined;
  @VirtualDbProperty()
  public TranscriptNamedEntities: Models.NamedEntity[] | undefined;

  constructor(data: ContextItem & BaseTenantDataModel) {
    super(data);
    this.consultationId = data.consultationId;
    this.type = data.type;
    this.source = data.source ?? Enums.ContextItemSource.USER;
    this.currentVersionNumber = data.currentVersionNumber ?? 1;
    this.content = data.content;
    this.encryptedContent = data.encryptedContent;
    this.contentKeyVersion = data.contentKeyVersion;
    this.mediaId = data.mediaId;
    this.dnaWritingStyleId = data.dnaWritingStyleId;
    this.qdrantSynced = data.qdrantSynced ?? false;
    this.qdrantSyncedAt = data.qdrantSyncedAt;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.Consultation = data.Consultation;
    this.AudioRecordings = data.AudioRecordings;
    this.SummaryMeta = data.SummaryMeta;
    this.NamedEntities = data.NamedEntities;
    this.Versions = data.Versions;
    this.TranscriptNamedEntities = data.TranscriptNamedEntities;
  }
}
