/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { McpServerEntity, IMcpServerEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateMcpServerProps extends BaseEntityFactoryCreateProps {
  tenantId: IMcpServerEntity['tenantId'];
  name: IMcpServerEntity['name'];
  baseUrl: IMcpServerEntity['baseUrl'];
  description?: IMcpServerEntity['description'];
  transport?: IMcpServerEntity['transport'];
  authRef?: IMcpServerEntity['authRef'];
  toolAllowlist?: IMcpServerEntity['toolAllowlist'];
  phiBoundary?: IMcpServerEntity['phiBoundary'];
  enabled?: IMcpServerEntity['enabled'];

  createdAt?: IMcpServerEntity['createdAt'];
  updatedAt?: IMcpServerEntity['updatedAt'];
  createdBy?: IMcpServerEntity['createdBy'];
  updatedBy?: IMcpServerEntity['updatedBy'];
}

export class McpServerFactory {
  static CreateMcpServer(props: CreateMcpServerProps): McpServerEntity {
    const id = generateId();
    const now = new Date();

    return new McpServerEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      name: props.name,
      description: props.description ?? null,
      baseUrl: props.baseUrl,
      // Only "streamable-http" is supported; default it.
      transport: props.transport ?? 'streamable-http',
      authRef: props.authRef ?? null,
      toolAllowlist: props.toolAllowlist ?? null,
      // Fail-safe default: unmarked ⇒ external (cloud egress).
      phiBoundary: props.phiBoundary ?? 'external',
      // Dormant until explicitly enabled (defence in depth on the feature flag).
      enabled: props.enabled ?? false,
    });
  }
}
