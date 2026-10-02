import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ComposedPromptRecordEntity } from '../../../entities/generated/core/ComposedPromptRecordEntity';

export interface CreateComposedPromptRecordProps extends BaseEntityFactoryCreateProps {
  tenantId: string;
  consultationId?: string | null;
  agentSlug?: string | null;
  phase: string;
  provider: string;
  locality: string;
  systemCiphertext: Buffer;
  userCiphertext: Buffer;
  keyVersion?: number | null;
  sha256: string;
  createdAt?: Date;
  updatedAt?: Date;
  createdBy?: string | null;
  updatedBy?: string | null;
}

export class ComposedPromptRecordFactory {
  static CreateComposedPromptRecord(props: CreateComposedPromptRecordProps): ComposedPromptRecordEntity {
    const now = new Date();
    return new ComposedPromptRecordEntity({
      id: generateId(),
      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy ?? null,
      tenantId: props.tenantId,
      consultationId: props.consultationId ?? null,
      agentSlug: props.agentSlug ?? null,
      phase: props.phase,
      provider: props.provider,
      locality: props.locality,
      systemCiphertext: props.systemCiphertext,
      userCiphertext: props.userCiphertext,
      keyVersion: props.keyVersion ?? null,
      sha256: props.sha256,
    });
  }
}
