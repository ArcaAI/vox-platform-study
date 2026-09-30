import { Controller } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Authorize, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * Model registration from a path already in the models bucket (TASK-1023 R4c):
 * `GET admin/ai-models/local/preview` and `POST admin/ai-models/register-from-path`.
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
export class AiModelRegistrationController {}
