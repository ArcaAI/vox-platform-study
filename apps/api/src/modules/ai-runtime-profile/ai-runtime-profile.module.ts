import { AiRuntimeProfileServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { AiRuntimeProfileController } from './ai-runtime-profile.controller';

/**
 * AiRuntimeProfileModule — mounts the `/admin/ai-runtime-profiles`
 * surface. `AiRuntimeProfileService` (the per-field injection cascade, range
 * clamps, global-admin/SYSTEM-only governance, OCC row writes) comes from
 * `@arcaai/applications`.
 */
@Module({
  imports: [AiRuntimeProfileServiceModule],
  controllers: [AiRuntimeProfileController],
})
export class AiRuntimeProfileModule {}
