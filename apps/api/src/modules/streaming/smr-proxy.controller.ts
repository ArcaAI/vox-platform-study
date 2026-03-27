import { Authorize, IActiveUserContext, ITenantService } from '@arcaai/applications';
import { ContextItemRepository, DepartmentRepository, DnaWritingStyleReportRepository, PromptTemplateRepository } from '@arcaai/domains';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { AxiosError } from 'axios';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { JwtAuthGuard } from '../../guards';

interface SmrResponseFormat {
  type: 'text' | 'json' | 'json_schema';
  json_schema?: Record<string, unknown>;
  strict?: boolean;
}

interface SmrGenerateRequest {
  prompt: string;
  system_prompt?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  response_format?: SmrResponseFormat;
  context?: Record<string, unknown>;
}

type VisitType = 'new_visit' | 'referral';
type GenerationType = 'pre-summary' | 'summary';

interface AssembledGenerateRequest {
  type: GenerationType;
  visit_type?: VisitType;
  context_item_ids?: string[];
  message?: string;
  prompt_template_id?: string;
  dna_writing_style_id?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  debug?: boolean;
}

interface UpstreamErrorPayload {
  detail?: string;
  message?: string;
  error_code?: string;
  [key: string]: unknown;
}

const RETRIABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']);
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
const GLOBAL_TENANT_KEY = '__GLOBAL__';
const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';
const TENANT_PROVIDER_SETTINGS_LIMIT = 200;

interface TenantSettingLike {
  key: string;
  value: string;
}

interface ProviderCatalogModel {
  name?: string;
  id?: string;
  size?: string;
}

interface ProviderCatalogEntry {
  provider: string;
  models: ProviderCatalogModel[];
}

@ApiTags('text')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('text')
export class SmrProxyController {
  private readonly logger = new Logger(SmrProxyController.name);

  constructor(
    private readonly httpService: HttpService,
    @Inject(ITenantService)
    private readonly tenantService: ITenantService,
    private readonly clsService: ClsService<IActiveUserContext>,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly promptTemplateRepository: PromptTemplateRepository,
    private readonly dnaWritingStyleRepository: DnaWritingStyleReportRepository,
    private readonly departmentRepository: DepartmentRepository,
  ) {}

  private getSmrBaseUrl(): string {
    return process.env.SMR_URL || 'http://localhost:8862';
  }

  private getForwardHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    const serviceToken = process.env.SMR_SERVICE_TOKEN;
    if (serviceToken) {
      headers['X-Service-Token'] = serviceToken;
    }
    return headers;
  }

  private isRetriable(err: unknown): boolean {
    const code = (err as AxiosError)?.code;
    if (code && RETRIABLE_CODES.has(code)) return true;
    const status = (err as AxiosError)?.response?.status;
    return status === 502 || status === 503 || status === 504;
  }

  private buildUpstreamException(err: unknown, fallbackMessage: string): HttpException {
    const axiosError = err as AxiosError<UpstreamErrorPayload | string>;
    const status = axiosError.response?.status;
    const payload = axiosError.response?.data;

    if (typeof status === 'number') {
      if (typeof payload === 'string' && payload.trim().length > 0) {
        return new HttpException({ detail: payload }, status);
      }
      if (payload && typeof payload === 'object') {
        return new HttpException(payload, status);
      }
      return new HttpException({ detail: fallbackMessage }, status);
    }

    return new HttpException({ detail: fallbackMessage }, HttpStatus.BAD_GATEWAY);
  }

  private async withRetry<T>(fn: () => Promise<T>, context: string, maxRetries = 2): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries && this.isRetriable(err)) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt), 4000);
          this.logger.warn({
            message: `Retrying ${context}`,
            attempt: attempt + 1,
            maxRetries,
            delayMs,
            error: err instanceof Error ? err.message : String(err),
          });
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        break;
      }
    }
    throw lastErr;
  }

  private async resolveTenantId(): Promise<string> {
    const tenantId = this.clsService.get('tenantId');
    if (tenantId) return tenantId;

    const user = this.clsService.get('user') as { roles?: string[] } | undefined;
    if (user?.roles?.includes(SUPER_ADMIN_ROLE)) {
      const globalTenant = await this.tenantService.fetchByCodeName(GLOBAL_TENANT_KEY);
      return globalTenant.id;
    }

    throw new UnauthorizedException('No tenant context available');
  }

  private parseModelList(rawValue: string | undefined): string[] {
    if (!rawValue) return [];

    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item === 'object' && 'name' in item && typeof item.name === 'string') {
              return item.name;
            }
            if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string') {
              return item.id;
            }
            return '';
          })
          .filter((item) => item.length > 0);
      }
    } catch {
      // Not JSON, fallback to treating value as a single model slug.
    }

    return [rawValue];
  }

  private normalizeCatalogModels(models: ProviderCatalogModel[]): { name: string; size: string }[] {
    return models
      .map((model) => ({
        name: (model.name ?? model.id ?? '').trim(),
        size: model.size ?? '',
      }))
      .filter((model) => model.name.length > 0);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildProvidersFromTenantSettings(settings: TenantSettingLike[]): any[] {
    const defaultProvider = settings.find((setting) => setting.key === 'default-smr-provider')?.value?.trim();
    const defaultModelRaw = settings.find((setting) => setting.key === 'default-smr-model')?.value;
    const catalogRaw = settings.find((setting) => setting.key === 'smr-provider-models')?.value;

    const catalog = this.parseProviderCatalog(catalogRaw);
    if (catalog && catalog.length > 0) {
      return catalog.map((entry: ProviderCatalogEntry) => {
        const models = this.normalizeCatalogModels(entry.models);
        const firstModelName = models[0]?.name;
        return {
          name: entry.provider,
          models,
          is_available: true,
          is_default: entry.provider === defaultProvider,
          default_model: entry.provider === defaultProvider ? defaultModelRaw?.trim() || firstModelName : firstModelName,
        };
      });
    }

    const models = this.parseModelList(defaultModelRaw);
    const defaultModel = models[0];

    if (!defaultProvider && !defaultModel) {
      return [];
    }

    return [
      {
        name: defaultProvider || 'default',
        models,
        is_available: true,
        default_model: defaultModel,
      },
    ];
  }

  private parseProviderCatalog(rawValue: string | undefined): ProviderCatalogEntry[] | null {
    if (!rawValue) return null;
    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0] && typeof parsed[0] === 'object' && 'provider' in parsed[0]) {
        return parsed as ProviderCatalogEntry[];
      }
    } catch {
      // Malformed JSON, fall back to legacy behavior
    }
    return null;
  }

  @Post('generate')
  @Authorize()
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Generate text via SMR v2 (sync or streaming)' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async generate(@Body() body: SmrGenerateRequest): Promise<any> {
    const base = this.getSmrBaseUrl();

    try {
      const response = await this.withRetry(
        () =>
          this.httpService.axiosRef.post(`${base}/api/v1/generate`, body, {
            headers: this.getForwardHeaders(),
            timeout: body.stream ? 30_000 : 120_000,
          }),
        'SMR generate',
      );

      return response.data;
    } catch (err) {
      const upstreamStatus = (err as AxiosError)?.response?.status;
      this.logger.error({
        message: 'Failed to proxy generate request to SMR',
        error: err instanceof Error ? err.message : String(err),
        code: (err as AxiosError)?.code,
        upstreamStatus,
      });
      throw this.buildUpstreamException(err, 'SMR service unavailable');
    }
  }

  @Get('tasks/:taskId')
  @Authorize()
  @ApiOperation({ summary: 'Get task status from SMR v2' })
  @ApiParam({ name: 'taskId', description: 'Task ID' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getTaskStatus(@Param('taskId') taskId: string): Promise<any> {
    const base = this.getSmrBaseUrl();

    try {
      const response = await this.withRetry(
        () =>
          this.httpService.axiosRef.get(`${base}/api/v1/tasks/${taskId}`, {
            headers: this.getForwardHeaders(),
          }),
        `SMR task status ${taskId}`,
      );

      return response.data;
    } catch (err) {
      const upstreamStatus = (err as AxiosError)?.response?.status;
      this.logger.error({
        message: 'Failed to get task status from SMR',
        taskId,
        error: err instanceof Error ? err.message : String(err),
        upstreamStatus,
      });
      throw this.buildUpstreamException(err, 'SMR service unavailable');
    }
  }

  @Post('tasks/:taskId/cancel')
  @Authorize()
  @ApiOperation({ summary: 'Cancel a running SMR task' })
  @ApiParam({ name: 'taskId', description: 'Task ID to cancel' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async cancelTask(@Param('taskId') taskId: string): Promise<any> {
    const base = this.getSmrBaseUrl();

    try {
      const response = await this.httpService.axiosRef.post(`${base}/api/v1/tasks/${taskId}/cancel`, {}, { headers: this.getForwardHeaders() });

      return response.data;
    } catch (err) {
      const upstreamStatus = (err as AxiosError)?.response?.status;
      this.logger.error({
        message: 'Failed to cancel SMR task',
        taskId,
        error: err instanceof Error ? err.message : String(err),
        upstreamStatus,
      });
      throw this.buildUpstreamException(err, 'SMR service unavailable');
    }
  }

  @Get('tasks/:taskId/stream')
  @Authorize()
  @ApiOperation({ summary: 'Stream task chunks via SSE from SMR v2' })
  @ApiParam({ name: 'taskId', description: 'Task ID to stream' })
  async streamTaskEvents(@Param('taskId') taskId: string, @Res() res: Response): Promise<void> {
    const base = this.getSmrBaseUrl();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    try {
      const upstream = await this.httpService.axiosRef.get(`${base}/api/v1/tasks/${taskId}/stream`, {
        headers: { ...this.getForwardHeaders(), Accept: 'text/event-stream' },
        responseType: 'stream',
        timeout: 300_000,
      });

      const stream = upstream.data;

      heartbeatTimer = setInterval(() => {
        if (!res.writableEnded) {
          res.write(':keepalive\n\n');
        }
      }, SSE_HEARTBEAT_INTERVAL_MS);

      stream.on('data', (chunk: Buffer) => {
        res.write(chunk);
      });

      stream.on('end', () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        res.end();
      });

      stream.on('error', (err: Error) => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        this.logger.error({
          message: 'SSE stream error from SMR',
          taskId,
          error: err.message,
        });
        res.end();
      });

      res.on('close', () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        stream.destroy();
      });
    } catch (err) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      const axiosError = err as AxiosError<UpstreamErrorPayload | string>;
      const upstreamStatus = axiosError.response?.status;
      const upstreamPayload = axiosError.response?.data;
      this.logger.error({
        message: 'Failed to connect to SMR SSE stream',
        taskId,
        error: err instanceof Error ? err.message : String(err),
        upstreamStatus,
      });
      if (!res.headersSent) {
        if (typeof upstreamStatus === 'number') {
          if (typeof upstreamPayload === 'string' && upstreamPayload.trim().length > 0) {
            res.status(upstreamStatus).json({ detail: upstreamPayload });
          } else if (upstreamPayload && typeof upstreamPayload === 'object') {
            res.status(upstreamStatus).json(upstreamPayload);
          } else {
            res.status(upstreamStatus).json({ detail: 'SMR service unavailable' });
          }
        } else {
          res.status(HttpStatus.BAD_GATEWAY).json({ detail: 'SMR service unavailable' });
        }
      } else {
        res.end();
      }
    }
  }

  @Post('generate/assembled')
  @Authorize()
  @ApiOperation({ summary: 'Generate text with server-side prompt assembly (debug mode)' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async generateAssembled(@Body() body: AssembledGenerateRequest): Promise<any> {
    this.validateAssembledRequest(body);
    this.requireDebugAccess(body.debug);

    const { prompt, systemPrompt, resolvedMeta } = await this.assemblePrompt(body);

    const smrPayload: SmrGenerateRequest = {
      prompt,
      system_prompt: systemPrompt,
      provider: body.provider,
      model: body.model,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      stream: body.stream ?? false,
    };

    const base = this.getSmrBaseUrl();

    try {
      const response = await this.withRetry(
        () =>
          this.httpService.axiosRef.post(`${base}/api/v1/generate`, smrPayload, {
            headers: this.getForwardHeaders(),
            timeout: smrPayload.stream ? 30_000 : 120_000,
          }),
        'SMR assembled generate',
      );

      return {
        ...response.data,
        _debug: {
          assembled: true,
          type: body.type,
          visit_type: body.visit_type,
          prompt_template_id: resolvedMeta.promptTemplateId,
          prompt_template_name: resolvedMeta.promptTemplateName,
          dna_writing_style_id: resolvedMeta.dnaStyleId,
          context_item_ids: body.context_item_ids,
          prompt_length: prompt.length,
          system_prompt_length: systemPrompt.length,
        },
      };
    } catch (err) {
      const upstreamStatus = (err as AxiosError)?.response?.status;
      this.logger.error({
        message: 'Failed to proxy assembled generate request to SMR',
        error: err instanceof Error ? err.message : String(err),
        code: (err as AxiosError)?.code,
        upstreamStatus,
      });
      throw this.buildUpstreamException(err, 'SMR service unavailable');
    }
  }

  private validateAssembledRequest(body: AssembledGenerateRequest): void {
    if (!body.type || !['pre-summary', 'summary'].includes(body.type)) {
      throw new BadRequestException('type must be "pre-summary" or "summary"');
    }
    if (!body.context_item_ids && !body.message) {
      throw new BadRequestException('Either context_item_ids or message is required');
    }
    if (body.context_item_ids && body.message) {
      throw new BadRequestException('Provide either context_item_ids or message, not both');
    }
    if (body.context_item_ids && body.context_item_ids.length === 0) {
      throw new BadRequestException('context_item_ids must not be empty');
    }
    if (body.visit_type && !['new_visit', 'referral'].includes(body.visit_type)) {
      throw new BadRequestException('visit_type must be "new_visit" or "referral"');
    }
  }

  private requireDebugAccess(debug?: boolean): void {
    if (!debug) return;

    const user = this.clsService.get('user') as { roles?: string[] } | undefined;
    const roles = user?.roles ?? [];
    const hasAdminAccess = roles.some((r) => ['SUPER_ADMIN', 'GLOBAL_ADMIN', 'TENANT_ADMIN'].includes(r));

    if (!hasAdminAccess) {
      throw new ForbiddenException('Debug mode requires SUPER_ADMIN, GLOBAL_ADMIN, or TENANT_ADMIN role');
    }
  }

  private async assemblePrompt(body: AssembledGenerateRequest): Promise<{
    prompt: string;
    systemPrompt: string;
    resolvedMeta: {
      promptTemplateId?: string;
      promptTemplateName?: string;
      dnaStyleId?: string;
    };
  }> {
    const TYPE_LABEL_MAP: Record<string, string> = {
      TRANSCRIPT: 'Transcript',
      CASE_NOTE: 'Case Note',
      WORKNOTE: 'Work Note',
      RAW_SUMMARY: 'Summary',
      MODIFIED_SUMMARY: 'Edited Summary',
      PRE_SUMMARY: 'Pre-Summary',
      // AUDIO_RECORDING: 'Audio',
      // ATTACHMENT: 'Attachment',
    };

    let context: string;
    if (body.context_item_ids) {
      const contentBlocks: string[] = [];
      for (const id of body.context_item_ids) {
        const contextItem = await this.contextItemRepository.findById(id);
        if (!contextItem) {
          throw new NotFoundException(`Context item ${id} not found`);
        }
        if (contextItem.content) {
          const label = TYPE_LABEL_MAP[contextItem.type] ?? 'Context';
          contentBlocks.push(`${label}:\n${contextItem.content}`);
        }
      }
      if (contentBlocks.length === 0) {
        throw new BadRequestException('None of the provided context items have content');
      }
      context = contentBlocks.join('\n\n');
    } else {
      context = body.message!;
    }

    let systemPrompt = '';
    let promptTemplateId: string | undefined;
    let promptTemplateName: string | undefined;

    if (body.prompt_template_id) {
      const template = await this.promptTemplateRepository.findById(body.prompt_template_id);
      if (!template) {
        throw new NotFoundException(`Prompt template ${body.prompt_template_id} not found`);
      }
      systemPrompt = template.content ?? '';
      promptTemplateId = template.id;
      promptTemplateName = template.name;
    } else {
      systemPrompt =
        body.type === 'pre-summary'
          ? 'You are a medical documentation assistant. Generate a concise pre-summary from the provided clinical context. Focus on key findings, diagnoses, medications, and treatment plans.'
          : 'You are a medical documentation assistant. Generate a comprehensive clinical summary from the provided transcript and context.';
    }

    if (body.dna_writing_style_id) {
      const dnaStyle = await this.dnaWritingStyleRepository.findById(body.dna_writing_style_id);
      if (dnaStyle?.styleText) {
        systemPrompt += `\n\nApply the following writing style:\n${dnaStyle.styleText}`;
      }
    }

    if (body.visit_type) {
      const visitLabel = body.visit_type === 'new_visit' ? 'new patient visit' : 'referral visit';
      systemPrompt += `\n\nThis is a ${visitLabel}.`;
    }

    const typeLabel = body.type === 'pre-summary' ? 'pre-summary' : 'clinical summary';
    const prompt = `Generate a ${typeLabel} from the following:\n\n${context}`;

    return {
      prompt,
      systemPrompt,
      resolvedMeta: {
        promptTemplateId,
        promptTemplateName,
        dnaStyleId: body.dna_writing_style_id,
      },
    };
  }

  @Get('providers')
  @Authorize()
  @ApiOperation({ summary: 'List configured LLM providers from tenant settings' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getProviders(): Promise<any[]> {
    const tenantId = await this.resolveTenantId();
    const configs = await this.tenantService.fetchTenantConfigs({
      tenantId,
      limit: TENANT_PROVIDER_SETTINGS_LIMIT,
      page: 1,
    });

    return this.buildProvidersFromTenantSettings(
      configs.data.map((setting) => ({
        key: setting.key,
        value: setting.value,
      })),
    );
  }
}
