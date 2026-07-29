/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AiProviderConnectionEntity, IAiProviderConnectionEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateAiProviderConnectionProps extends BaseEntityFactoryCreateProps {
  tenantId: IAiProviderConnectionEntity['tenantId'];
  /**
   * Capability discriminator (llm | stt | tts). Optional at the factory level
   * and defaulting to 'llm' — mirrors the Prisma column default and keeps the
   * pre-unification call convention compiling for the one-release transition.
   * The application service always passes it explicitly.
   */
  service?: IAiProviderConnectionEntity['service'];
  provider: IAiProviderConnectionEntity['provider'];
  baseUrl?: IAiProviderConnectionEntity['baseUrl'];
  region?: IAiProviderConnectionEntity['region'];
  apiVersion?: IAiProviderConnectionEntity['apiVersion'];
  deploymentName?: IAiProviderConnectionEntity['deploymentName'];
  encryptedApiKey?: IAiProviderConnectionEntity['encryptedApiKey'];
  keyVersion?: IAiProviderConnectionEntity['keyVersion'];
  enabled?: IAiProviderConnectionEntity['enabled'];
  extraJson?: IAiProviderConnectionEntity['extraJson'];

  createdAt?: IAiProviderConnectionEntity['createdAt'];
  updatedAt?: IAiProviderConnectionEntity['updatedAt'];
  createdBy?: IAiProviderConnectionEntity['createdBy'];
  updatedBy?: IAiProviderConnectionEntity['updatedBy'];
}

export class AiProviderConnectionFactory {
  static CreateAiProviderConnection(props: CreateAiProviderConnectionProps): AiProviderConnectionEntity {
    const id = generateId();
    const now = new Date();

    return new AiProviderConnectionEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      service: props.service ?? 'llm',
      provider: props.provider,
      baseUrl: props.baseUrl ?? null,
      region: props.region ?? null,
      apiVersion: props.apiVersion ?? null,
      deploymentName: props.deploymentName ?? null,
      encryptedApiKey: props.encryptedApiKey ?? null,
      keyVersion: props.keyVersion ?? null,
      // Fail-safe default: a freshly created connection is INERT until an
      // admin explicitly enables it, so resolution keeps falling through to
      // the consuming service's env configuration. Mirrors the Prisma default.
      enabled: props.enabled ?? false,
      extraJson: props.extraJson ?? null,
    });
  }
}
