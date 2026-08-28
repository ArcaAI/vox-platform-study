/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class DocumentSection extends BaseTenantDataModel {
  public consultationId: string;
  public documentKey: string;
  public sectionKey: string;
  public title: string;
  public idx: number;
  public state: Enums.DocumentSectionState;
  public revision: number;
  public encryptedContent: Uint8Array | null;
  public contentKeyVersion: number | null;
  public annotations: JsonValue | null;
  public provenance: JsonValue | null;
  public documentTemplateVersionId: string | null;
  public confirmedAt: Date | null;
  public confirmedBy: string | null;
  public lockedAt: Date | null;
  @VirtualDbProperty()
  public Consultation: Models.Consultation | undefined;

  constructor(data: DocumentSection & BaseTenantDataModel) {
    super(data);
    this.consultationId = data.consultationId;
    this.documentKey = data.documentKey;
    this.sectionKey = data.sectionKey;
    this.title = data.title;
    this.idx = data.idx;
    this.state = data.state;
    this.revision = data.revision;
    this.encryptedContent = data.encryptedContent;
    this.contentKeyVersion = data.contentKeyVersion;
    this.annotations = data.annotations;
    this.provenance = data.provenance;
    this.documentTemplateVersionId = data.documentTemplateVersionId;
    this.confirmedAt = data.confirmedAt;
    this.confirmedBy = data.confirmedBy;
    this.lockedAt = data.lockedAt;
    this.Consultation = data.Consultation;
  }
}
