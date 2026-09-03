import { Controller, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { redirect308 } from '../../common';
import { Authorize, RequiredScopes } from '../../decorators';

/**
 * redirect shim — DELETE IN ALL-2.0.0. Old paths retired 2026-08-18.
 *
 * The `ai` prefix is split (decision D-2): `ai/guardrail/analyze` →
 * `safety-checks`, `ai/nlp/*` → `text-analyses/*`.
 */
@ApiTags('ai-inference')
@ApiBearerAuth()
@Controller('ai')
@RequiredScopes('ai:inference:write')
export class AiInferenceRedirectShimController {
  @Post('guardrail/analyze')
  @Authorize()
  @ApiExcludeEndpoint()
  analyzeGuardrail(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'safety-checks');
  }

  @Post('nlp/entities')
  @Authorize()
  @ApiExcludeEndpoint()
  extractEntities(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'text-analyses/entities');
  }

  @Post('nlp/diagnosis')
  @Authorize()
  @ApiExcludeEndpoint()
  suggestDiagnosis(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'text-analyses/diagnosis');
  }

  @Post('nlp/topic')
  @Authorize()
  @ApiExcludeEndpoint()
  classifyTopic(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'text-analyses/topic');
  }

  @Post('nlp/intent')
  @Authorize()
  @ApiExcludeEndpoint()
  classifyIntent(@Req() req: Request, @Res() res: Response): void {
    redirect308(req, res, 'text-analyses/intent');
  }
}
