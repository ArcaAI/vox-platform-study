import {
  LocalModelPreviewQuery,
  LocalModelPreviewResponse,
  ModelPathRegistrationService,
  ModelResponse,
  RegisterFromPathRequest,
} from '@arcaai/applications';
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
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
export class AiModelRegistrationController {
  constructor(private readonly pathRegistration: ModelPathRegistrationService) {}

  /**
   * Inspect a folder or file in the models bucket and show what registering it would record.
   */
  @Get('local/preview')
  @ApiOperation({
    summary: 'Preview a model already in the models bucket',
    description:
      'Reads the objects under a path in the models bucket and returns what registering it would record: the bucket prefix, the ' +
      'path every serving pod loads, the primary file for a single-file loader, the layout (Hugging Face cache snapshot, published ' +
      'folder or plain files), every file with its size, the snapshot commit when there is one, and the registry fields derived from ' +
      'the files and `config.json` (slug, name, task, serving library, format, serving workload, architecture, compute type). The path ' +
      'may be given as the mount path, bucket-qualified, as an `s3://` URI or bare; a file path previews its folder. Nothing is written.',
  })
  @ApiResponse({ status: 200, type: LocalModelPreviewResponse })
  @ApiResponse({
    status: 400,
    description:
      "`PATH_INVALID` — the path is empty, the bucket root, contains a '.' or '..' segment, names another bucket, or is an ambiguous Hugging Face cache repo.",
  })
  @ApiResponse({ status: 403, description: 'Platform administrators only, with no working tenant selected.' })
  @ApiResponse({ status: 404, description: '`PATH_EMPTY` — nothing is stored under that path.' })
  async previewLocal(@Query() query: LocalModelPreviewQuery): Promise<LocalModelPreviewResponse> {
    return this.pathRegistration.previewLocal(query.path);
  }

  /**
   * Register a model whose weights are already in the models bucket.
   */
  @Post('register-from-path')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a model from a path in the models bucket',
    description:
      'Creates a platform model row (source `LOCAL`, self-hosted) for weights already stored in the models bucket — nothing is ' +
      'downloaded. Everything is derived as for the preview; any optional field in the body overrides what was derived. A model ' +
      'served by vLLM gets an estimated GPU memory size (weights × 1.25 + 1 GiB, marked as derived) so it can be served at once.',
  })
  @ApiResponse({ status: 201, type: ModelResponse })
  @ApiResponse({
    status: 400,
    description:
      '`PATH_INVALID` as for the preview; `SERVED_BY_REQUIRED` / `LIBRARY_REQUIRED` / `FORMAT_REQUIRED` — the files do not say it, ' +
      'choose it; `PRIMARY_OBJECT_REQUIRED` — a single-file loader and not exactly one candidate file, choose the file as the path; ' +
      '`INVALID_REGISTRATION` — the resulting row is invalid.',
  })
  @ApiResponse({ status: 403, description: 'Platform administrators only, with no working tenant selected.' })
  @ApiResponse({ status: 404, description: '`PATH_EMPTY` — nothing is stored under that path.' })
  @ApiResponse({ status: 409, description: '`SLUG_TAKEN` — a model with that slug is already registered.' })
  async registerFromPath(@Body() request: RegisterFromPathRequest): Promise<ModelResponse> {
    return this.pathRegistration.registerFromPath(request);
  }
}
