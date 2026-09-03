import { Logger, Req, Res } from '@nestjs/common';
import { SecretsService } from '@arcaai/applications';
import { Request, Response } from 'express';
import { type IncomingMessage, ServerResponse } from 'http';
import type { Socket } from 'net';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';

import { redactTopology } from '../filters/downstream-error';

export interface ProxyControllerConfig {
  serviceUrl: string;
  serviceName: string;
  pathRewriteFrom: string;
  pathRewriteTo: string;
  proxyTimeout?: number;
  timeout?: number;
}

const EXPECTED_NETWORK_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', 'EHOSTUNREACH']);

export abstract class BaseProxyController {
  abstract readonly config: ProxyControllerConfig;
  /**
   * Optional SecretsService accessor. Subclasses that proxy TEXT (or any
   * upstream needing a service token) inject SecretsService and expose
   * it here so the synchronous `on.proxyReq` hook can read the
   * cache-warmed token via `getSecretSync`. Subclasses that don't need
   * a token leave this undefined.
   */
  protected get secrets(): SecretsService | undefined {
    return undefined;
  }

  protected readonly logger = new Logger(this.constructor.name);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _proxy: ((req: any, res: any, next?: any) => void) | null = null;

  private getErrorDetail(err: Error): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const code = (err as any).code as string | undefined;
    return err.message || code || 'Unknown proxy error';
  }

  private isExpectedNetworkError(err: Error): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const code = (err as any).code as string | undefined;
    return !!code && EXPECTED_NETWORK_ERRORS.has(code);
  }

  protected get proxy() {
    if (!this._proxy) {
      const { config } = this;

      this._proxy = createProxyMiddleware({
        target: config.serviceUrl,
        changeOrigin: true,
        pathRewrite: { [config.pathRewriteFrom]: config.pathRewriteTo },
        secure: true,
        on: {
          proxyReq: (proxyReq, req, res) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (fixRequestBody as any)(proxyReq, req, res);

            // Read TEXT token from SecretsService cache (warmed at bootstrap).
            // Sync lookup because on.proxyReq cannot await. Cold cache -> no
            // header (fail-open, same as an unset env var).
            const serviceToken = this.secrets?.getSecretSync('TEXT_SERVICE_TOKEN');
            if (serviceToken) {
              proxyReq.setHeader('X-Service-Token', serviceToken);
            }
          },
          proxyRes: (proxyRes: IncomingMessage, req: IncomingMessage) => {
            if (proxyRes.statusCode! >= 400) {
              this.logger.error({
                message: 'Proxy error response',
                method: req.method,
                path: req.url,
                status: proxyRes.statusCode,
              });
            } else {
              this.logger.debug({
                message: 'Proxy response',
                method: req.method,
                path: req.url,
                status: proxyRes.statusCode,
              });
            }
          },
          error: (err: Error, req: IncomingMessage, res: ServerResponse | Socket) => {
            const errorDetail = this.getErrorDetail(err);
            const logPayload = {
              message: 'Proxy error',
              service: config.serviceName,
              target: config.serviceUrl,
              method: req.method,
              path: req.url,
              error: errorDetail,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              code: (err as any).code,
            };

            if (this.isExpectedNetworkError(err)) {
              this.logger.warn(logPayload);
            } else {
              this.logger.error(logPayload);
            }

            if (res instanceof ServerResponse && !res.headersSent) {
              // `errorDetail` is `err.message || err.code` — i.e.
              // `connect ECONNREFUSED 127.0.0.1:8862`. It stays in `logPayload`
              // above (operator) and is redacted out of the body (client). The
              // status is 503, not 502: a proxy `error` event means the peer was
              // never reached. This class has no production subclasses today,
              // but it is the template the next proxy will be copied from —
              // which is exactly why it must not model the leak.
              const body = JSON.stringify({
                error: `${config.serviceName} service unavailable`,
                detail: redactTopology(errorDetail),
                timestamp: new Date().toISOString(),
              });
              res.writeHead(503, {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              });
              res.end(body);
            }
          },
        },
        proxyTimeout: config.proxyTimeout ?? 60000,
        timeout: config.timeout ?? 60000,
      });
    }
    return this._proxy;
  }

  proxyRequest(@Req() req: Request, @Res() res: Response) {
    const startTime = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestId = (req as any).requestId || req.headers['x-request-id'] || Math.random().toString(36).substring(2, 15);
    req.headers['x-request-id'] = requestId;
    req.headers['x-correlation-id'] = requestId;

    this.logger.debug({
      message: 'Proxy request started',
      requestId,
      method: req.method,
      path: req.url,
    });

    this.proxy(req, res, (err: Error | undefined) => {
      const durationMs = Date.now() - startTime;

      if (err) {
        this.logger.error({
          message: 'Proxy request failed',
          requestId,
          method: req.method,
          path: req.url,
          durationMs,
          error: this.getErrorDetail(err),
        });

        if (!res.headersSent) {
          res.status(500).json({
            error: `${this.config.serviceName} service unavailable`,
            requestId,
            timestamp: new Date().toISOString(),
          });
        }
      } else {
        this.logger.debug({
          message: 'Proxy request completed',
          requestId,
          method: req.method,
          path: req.url,
          durationMs,
        });
      }
    });
  }
}
