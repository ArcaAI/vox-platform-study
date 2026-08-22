import { SecurityPolicyServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';

import { SecurityPolicyController } from './security-policy.controller';

/** Mounts `GET/PUT /admin/security/policy`. */
@Module({
  imports: [SecurityPolicyServiceModule],
  controllers: [SecurityPolicyController],
})
export class SecurityPolicyModule {}
