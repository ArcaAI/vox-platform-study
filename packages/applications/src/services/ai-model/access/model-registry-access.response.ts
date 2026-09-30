import { ApiProperty } from '@nestjs/swagger';
import type { ModelRegistryAccess } from '@arcaai/types';

/** `GET admin/ai-models/access` — what the caller may do on the model registry. */
export class ModelRegistryAccessResponse implements ModelRegistryAccess {
  @ApiProperty({
    description: 'True only for a platform administrator with no working tenant selected — the only caller who may change the registry.',
  })
  canManage!: boolean;

  @ApiProperty({
    description:
      "The effective `modelRegistry.tenantManagement.enabled` setting for the caller's tenant. Reported only: it does not let a tenant administrator change the registry.",
  })
  tenantManagementEnabled!: boolean;
}
