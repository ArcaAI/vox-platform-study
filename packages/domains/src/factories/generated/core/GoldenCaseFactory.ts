/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { GoldenCaseEntity, IGoldenCaseEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateGoldenCaseProps extends BaseEntityFactoryCreateProps {
  goldenSetId: IGoldenCaseEntity['goldenSetId'];
  label?: IGoldenCaseEntity['label'];
  transcript: IGoldenCaseEntity['transcript'];
  referenceNote: IGoldenCaseEntity['referenceNote'];
  tenantId: IGoldenCaseEntity['tenantId'];
  Tenant?: IGoldenCaseEntity['Tenant'];

  createdAt?: IGoldenCaseEntity['createdAt'];
  updatedAt?: IGoldenCaseEntity['updatedAt'];
  createdBy?: IGoldenCaseEntity['createdBy'];
  updatedBy?: IGoldenCaseEntity['updatedBy'];
}

export class GoldenCaseFactory {
  static CreateGoldenCase(props: CreateGoldenCaseProps): GoldenCaseEntity {
    const id = generateId();
    const now = new Date();

    return new GoldenCaseEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      goldenSetId: props.goldenSetId,
      label: props.label ?? null,
      transcript: props.transcript,
      referenceNote: props.referenceNote,
      tenantId: props.tenantId,
      Tenant: props.Tenant ?? null,
    });
  }
}
