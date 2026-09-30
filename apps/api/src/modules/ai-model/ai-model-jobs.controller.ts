import { Controller } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Authorize, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * Model-publisher job control (TASK-1023 R6): `GET admin/ai-models/jobs` and
 * `POST admin/ai-models/:id/download/cancel`.
 *
 * Registered BEFORE `AiModelAdminController` (static paths win over its `:id` family).
 *
 * AUTH-NOTE: `manage:all` understates the gate — the service requires a platform
 * admin (SUPER_ADMIN) with NO working tenant (`assertPlatformRegistryAdmin`).
 */
@ApiBearerAuth()
@ApiTags('admin-ai-models')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:ai-model:manage')
@Controller('admin/ai-models')
@Authorize(['manage', 'all'])
export class AiModelJobsController {}
