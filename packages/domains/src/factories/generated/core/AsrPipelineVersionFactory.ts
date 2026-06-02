/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AsrPipelineVersionEntity } from '../../../entities/generated/core/AsrPipelineVersionEntity';

export interface CreateAsrPipelineVersionProps extends BaseEntityFactoryCreateProps {
  asrPipelineId: string;
  versionNumber: number;
  configYaml: string;
  name?: string | null;
  description?: string | null;
  changeReason?: string | null;
  changedBy?: string | null;
  tenantId: string;
  createdAt?: Date;
  updatedAt?: Date;
  createdBy?: string | null;
  updatedBy?: string | null;
}

export class AsrPipelineVersionFactory {
  static CreateAsrPipelineVersion(props: CreateAsrPipelineVersionProps): AsrPipelineVersionEntity {
    const id = generateId();
    const now = new Date();
    return new AsrPipelineVersionEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy ?? null,
      tenantId: props.tenantId,
      asrPipelineId: props.asrPipelineId,
      versionNumber: props.versionNumber,
      configYaml: props.configYaml,
      name: props.name ?? null,
      description: props.description ?? null,
      changeReason: props.changeReason ?? null,
      changedBy: props.changedBy ?? null,
    });
  }
}
