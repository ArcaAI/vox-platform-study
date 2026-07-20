/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AiRuntimeProfileEntity, IAiRuntimeProfileEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateAiRuntimeProfileProps extends BaseEntityFactoryCreateProps {
  tenantId: IAiRuntimeProfileEntity['tenantId'];
  provider: IAiRuntimeProfileEntity['provider'];
  /** Omit (or pass `''`) for the provider-level default row. */
  modelSlug?: IAiRuntimeProfileEntity['modelSlug'];
  temperature?: IAiRuntimeProfileEntity['temperature'];
  topP?: IAiRuntimeProfileEntity['topP'];
  maxTokens?: IAiRuntimeProfileEntity['maxTokens'];
  contextLength?: IAiRuntimeProfileEntity['contextLength'];
  maxConcurrent?: IAiRuntimeProfileEntity['maxConcurrent'];
  tpmLimit?: IAiRuntimeProfileEntity['tpmLimit'];
  rpmLimit?: IAiRuntimeProfileEntity['rpmLimit'];
  timeoutS?: IAiRuntimeProfileEntity['timeoutS'];
  keepAliveSeconds?: IAiRuntimeProfileEntity['keepAliveSeconds'];
  extraJson?: IAiRuntimeProfileEntity['extraJson'];

  createdAt?: IAiRuntimeProfileEntity['createdAt'];
  updatedAt?: IAiRuntimeProfileEntity['updatedAt'];
  createdBy?: IAiRuntimeProfileEntity['createdBy'];
  updatedBy?: IAiRuntimeProfileEntity['updatedBy'];
}

export class AiRuntimeProfileFactory {
  static CreateAiRuntimeProfile(props: CreateAiRuntimeProfileProps): AiRuntimeProfileEntity {
    const id = generateId();
    const now = new Date();

    return new AiRuntimeProfileEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      provider: props.provider,
      // `''` (provider-level default), never null — the compound unique index
      // depends on a non-null member. Mirrors the Prisma default.
      modelSlug: props.modelSlug ?? '',
      // Every knob defaults to null = "no opinion, fall through the cascade".
      temperature: props.temperature ?? null,
      topP: props.topP ?? null,
      maxTokens: props.maxTokens ?? null,
      contextLength: props.contextLength ?? null,
      maxConcurrent: props.maxConcurrent ?? null,
      tpmLimit: props.tpmLimit ?? null,
      rpmLimit: props.rpmLimit ?? null,
      timeoutS: props.timeoutS ?? null,
      keepAliveSeconds: props.keepAliveSeconds ?? null,
      extraJson: props.extraJson ?? null,
    });
  }
}
