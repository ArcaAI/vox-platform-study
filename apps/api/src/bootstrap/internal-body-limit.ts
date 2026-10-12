import { createRequire } from 'node:module';
import type { INestApplication } from '@nestjs/common';

import { API_GLOBAL_PREFIX } from '../global-prefix.config';

/** Express' default JSON limit is 100 kB; a 100-row guardrail evaluation batch can exceed it. */
export const INTERNAL_BATCH_BODY_LIMIT = '2mb';

export const GUARDRAIL_EVALUATIONS_BODY_LIMIT_PATH = `/${API_GLOBAL_PREFIX}/internal/guardrail/evaluations`;

type JsonParserFactory = (options: { limit: string; verify: (req: unknown, res: unknown, buf: Buffer) => void }) => never;

/**
 * Raises the JSON body limit for the internal guardrail evaluation drain ONLY. The parser is mounted
 * on the route path ahead of Nest's own (registered at `init()`); body-parser skips a request whose
 * body is already parsed, so every other route keeps the framework default.
 */
export function applyInternalBodyLimits(app: INestApplication): void {
  const expressJson = createRequire(require.resolve('@nestjs/platform-express'))('express').json as JsonParserFactory;
  const parser = expressJson({
    limit: INTERNAL_BATCH_BODY_LIMIT,
    // Nest's `rawBody: true` capture, repeated because this parser consumes the stream first.
    verify: (req, _res, buf) => {
      if (Buffer.isBuffer(buf)) (req as { rawBody?: Buffer }).rawBody = buf;
    },
  });
  // Nest skips registering its own JSON parser when a middleware NAMED `jsonParser` is already in the
  // stack (body-parser's function name) — wrapping it keeps the default parser for every other route.
  app.use(GUARDRAIL_EVALUATIONS_BODY_LIMIT_PATH, (req: unknown, res: unknown, next: unknown) =>
    (parser as unknown as (a: unknown, b: unknown, c: unknown) => void)(req, res, next),
  );
}
