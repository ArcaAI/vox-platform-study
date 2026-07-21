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
  // Typed lifecycle state machine
  public status: Enums.ConsultationStatus;
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

  constructor(data: Consultation & BaseTenantDataModel) {
    super(data);
    this.patientId = data.patientId;
    this.appointmentDate = data.appointmentDate;
    this.doctorId = data.doctorId;
    this.departmentId = data.departmentId;
    this.parentConsultationId = data.parentConsultationId;
    this.metadata = data.metadata;
    this.status = data.status;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.Doctor = data.Doctor;
    this.Department = data.Department;
    this.ParentConsultation = data.ParentConsultation;
    this.ChildConsultations = data.ChildConsultations;
    this.ContextItems = data.ContextItems;
    this.Highlights = data.Highlights;
  }
}
