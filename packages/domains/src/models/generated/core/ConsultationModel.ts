/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class Consultation extends BaseTenantDataModel {
  public patientId: string;
  public appointmentDate: Date;
  public doctorId: string;
  public departmentId: string | null;
  public parentConsultationId: string | null;
  public metadata: JsonValue | null;
  public externalRef: string | null;
  // Typed lifecycle state machine
  public status: Enums.ConsultationStatus;
  public processing: Enums.ConsultationProcessing;
  public processingReason: string | null;
  public processingRefs: string[];
  public processingPrior: Enums.ConsultationProcessing | null;
  public processingUpdatedAt: Date | null;
  public lastActivityAt: Date;
  public reopenCount: number;
  public currentEncounterSeq: number;
  public segmentSeqHead: number;
  public recordingCursorMs: number;
  public approvedAt: Date | null;
  public closedAt: Date | null;
  public closedReason: Enums.ConsultationClosedReason | null;
  public degradedReasons: string[];
  public spokenLanguageMode: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public Doctor: Models.User | undefined;
  @VirtualDbProperty()
  public Department: Models.Department | undefined;
  @VirtualDbProperty()
  public ParentConsultation: Models.Consultation | undefined;
  @VirtualDbProperty()
  public ChildConsultations: Models.Consultation[] | undefined;
  @VirtualDbProperty()
  public ContextItems: Models.ContextItem[] | undefined;
  @VirtualDbProperty()
  public Highlights: Models.Highlight[] | undefined;
  @VirtualDbProperty()
  public DocumentSections: Models.DocumentSection[] | undefined;
  @VirtualDbProperty()
  public Encounters: Models.ConsultationEncounter[] | undefined;
  @VirtualDbProperty()
  public Approvals: Models.ConsultationApproval[] | undefined;

  constructor(data: Consultation & BaseTenantDataModel) {
    super(data);
    this.patientId = data.patientId;
    this.appointmentDate = data.appointmentDate;
    this.doctorId = data.doctorId;
    this.departmentId = data.departmentId;
    this.parentConsultationId = data.parentConsultationId;
    this.metadata = data.metadata;
    this.externalRef = data.externalRef;
    this.status = data.status;
    this.processing = data.processing;
    this.processingReason = data.processingReason;
    this.processingRefs = data.processingRefs;
    this.processingPrior = data.processingPrior;
    this.processingUpdatedAt = data.processingUpdatedAt;
    this.lastActivityAt = data.lastActivityAt;
    this.reopenCount = data.reopenCount;
    this.currentEncounterSeq = data.currentEncounterSeq;
    this.segmentSeqHead = data.segmentSeqHead;
    this.recordingCursorMs = data.recordingCursorMs;
    this.approvedAt = data.approvedAt;
    this.closedAt = data.closedAt;
    this.closedReason = data.closedReason;
    this.degradedReasons = data.degradedReasons;
    this.spokenLanguageMode = data.spokenLanguageMode;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.Doctor = data.Doctor;
    this.Department = data.Department;
    this.ParentConsultation = data.ParentConsultation;
    this.ChildConsultations = data.ChildConsultations;
    this.ContextItems = data.ContextItems;
    this.Highlights = data.Highlights;
    this.DocumentSections = data.DocumentSections;
    this.Encounters = data.Encounters;
    this.Approvals = data.Approvals;
  }
}
