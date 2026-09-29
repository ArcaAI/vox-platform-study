import { Authorize, IActiveUserContext, isSuperAdmin } from '@arcaai/applications';
import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';

import { ForbidApiKey, ForbidServiceAccount } from '../../decorators';
import { TextProxyController } from './text-proxy.controller';
import type { AssembledGenerateRequest, TextGenerateRequest } from './text-proxy.controller';

/**
 * TASK-1012 D-1 — RAW text-model pinning, moved off the business plane.
 *
 * `POST text-generations/generate[/assembled]` used to forward a caller's `provider` + `model`
 * verbatim; on the business plane a model is now selected only through an Agent, so those routes
 * refuse both fields (`MODEL_PINNING_NOT_ALLOWED`). What survives is the platform LLM playground's
 * need to drive one catalogue model directly — a platform-admin capability, so it lives here, on
 * the admin plane, behind a super-admin gate.
 *
 * It runs the SAME proxy pipeline as the business routes (`TextProxyController.proxyGenerate` /
 * `proxyGenerateAssembled`): quota pre-check, guardrail policy push, reasoning posture, BYO
 * credential fold, single-delivery retry and metering are one implementation, not two. A body
 * with no `model` still resolves through the tenant's TEXT_GENERATION agent, exactly as the
 * business route does. The task routes (`text-generations/tasks/*`) are shared as they are.
 *
 * Closed to BOTH machine credential classes: raw pinning is a human playground action, and a
 * service account reaching it would put engine selection back into `@arcaai/vox-node`'s admin
 * surface — the opposite of this ticket.
 */
@ApiBearerAuth()
@ApiTags('admin-ai-models')
@ForbidApiKey()
@ForbidServiceAccount()
@Controller('admin/text-generations')
@Authorize(['manage', 'all'])
export class TextGenerationAdminController {
  constructor(
    // The proxy is a CONTROLLER (it owns the business routes), so it is not injectable as a
    // provider; `ModuleRef.get` resolves the one instance Nest already built for this module.
    private readonly moduleRef: ModuleRef,
    private readonly clsService: ClsService<IActiveUserContext>,
  ) {}

  // AUTH-NOTE: the class-level `@Authorize(['manage', 'all'])` already confines this controller to
  // the platform administrator, and the imperative `isSuperAdmin` check below RESTATES that gate
  // in code on purpose: raw provider/model pinning is the one text path that bypasses Agent
  // selection, so it must stay platform-admin-only even if the class decorator is ever relaxed to
  // a model subject a tenant admin holds. A tenant admin is a PRIVILEGE 403 here, never the
  // 404-over-403 cross-tenant posture; the generation still runs inside the caller's working tenant.
  @Post('generate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate text on a pinned provider and model (platform LLM playground)',
    description:
      'The platform LLM playground path: the same text-generation pipeline as `POST text-generations/generate` (sync or ' +
      'streaming), with the caller-pinned `provider` and `model` forwarded untouched. The business route refuses both fields ' +
      '(`MODEL_PINNING_NOT_ALLOWED`) because a business caller selects a model only through an Agent. Omitting `model` ' +
      "resolves the working tenant's TEXT_GENERATION agent. Platform administrators only.",
  })
  @ApiResponse({ status: 200, description: 'The generation result, or the streaming acknowledgement carrying the task stream URL.' })
  @ApiResponse({ status: 403, description: 'The caller is not a platform administrator.' })
  @ApiResponse({ status: 429, description: 'The tenant is over its monthly LLM-token allowance, or the provider is rate limiting.' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the shared proxy pipeline returns the TEXT body untyped
  async generate(@Body() body: TextGenerateRequest, @Res({ passthrough: true }) res?: Response): Promise<any> {
    this.assertPlatformAdmin();
    return this.proxy().proxyGenerate(body, res);
  }

  // AUTH-NOTE: same gate as `generate` above — class-level `manage:all` plus the imperative
  // `isSuperAdmin` restatement; see that note.
  @Post('generate/assembled')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate text with server-side prompt assembly on a pinned provider and model (platform LLM playground)',
    description:
      'The platform LLM playground path of `POST text-generations/generate/assembled`: server-side prompt assembly ' +
      '(context items or a message, prompt template, DNA writing style) with the caller-pinned `provider` and `model` ' +
      'forwarded untouched. Platform administrators only.',
  })
  @ApiResponse({ status: 200, description: 'The generation result (with `_debug` assembly meta when requested).' })
  @ApiResponse({ status: 400, description: 'The assembly request is malformed (type, context source, or visit type).' })
  @ApiResponse({ status: 403, description: 'The caller is not a platform administrator.' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the shared proxy pipeline returns the TEXT body untyped
  async generateAssembled(@Body() body: AssembledGenerateRequest, @Res({ passthrough: true }) res?: Response): Promise<any> {
    this.assertPlatformAdmin();
    return this.proxy().proxyGenerateAssembled(body, res);
  }

  private assertPlatformAdmin(): void {
    if (!isSuperAdmin(this.clsService.get('user'))) {
      throw new ForbiddenException('Pinning a text provider and model is reserved to platform administrators.');
    }
  }

  private proxy(): TextProxyController {
    return this.moduleRef.get(TextProxyController, { strict: true });
  }
}
