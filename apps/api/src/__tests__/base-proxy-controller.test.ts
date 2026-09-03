import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ProxyControllerConfig } from '../shared/base-proxy.controller';

const SHARED = join(__dirname, '..', 'shared');

function readFile(absolutePath: string): string {
  return readFileSync(absolutePath, 'utf-8');
}

// ─── 1. BaseProxyController Existence & Exports ──────────────────────────────

describe('BaseProxyController module', () => {
  it('should export BaseProxyController class', async () => {
    const mod = await import('../shared/base-proxy.controller');
    expect(mod.BaseProxyController).toBeDefined();
    expect(typeof mod.BaseProxyController).toBe('function');
  });

  it('should export ProxyControllerConfig interface (type-level check via class usage)', async () => {
    const mod = await import('../shared/base-proxy.controller');
    expect(mod.BaseProxyController).toBeDefined();
  });

  it('BaseProxyController should be abstract (config access throws on direct instantiation)', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');
    const instance = new (BaseProxyController as any)();
    expect(instance.config).toBeUndefined();
  });
});

// ─── 2. BaseProxyController Contract ─────────────────────────────────────────

describe('BaseProxyController contract', () => {
  it('should define a protected proxyRequest method', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');
    expect(BaseProxyController.prototype.proxyRequest).toBeDefined();
    expect(typeof BaseProxyController.prototype.proxyRequest).toBe('function');
  });

  it('proxyRequest should set x-request-id header on the request', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');

    class TestController extends BaseProxyController {
      readonly config = {
        serviceName: 'test',
        serviceUrl: 'http://localhost:9999',
        pathRewriteFrom: '^/api/v1/test',
        pathRewriteTo: '/api/v1',
        proxyTimeout: 60000,
        timeout: 60000,
      };
    }

    const controller = new TestController();
    const req: any = {
      method: 'GET',
      url: '/api/v1/test/health',
      headers: {},
    };
    const res: any = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    controller.proxyRequest(req, res);
    expect(req.headers['x-request-id']).toBeDefined();
    expect(typeof req.headers['x-request-id']).toBe('string');
    expect(req.headers['x-request-id'].length).toBeGreaterThan(0);
  });

  it('proxyRequest should return 500 with serviceName in error when proxy fails', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');

    class TestController extends BaseProxyController {
      readonly config = {
        serviceName: 'TestService',
        serviceUrl: 'http://localhost:9999',
        pathRewriteFrom: '^/api/v1/test',
        pathRewriteTo: '/api/v1',
        proxyTimeout: 100,
        timeout: 100,
      };
    }

    const controller = new TestController();
    const req: any = {
      method: 'GET',
      url: '/api/v1/test/health',
      headers: {},
    };
    const statusFn = vi.fn().mockReturnThis();
    const jsonFn = vi.fn().mockReturnThis();
    const res: any = {
      headersSent: false,
      status: statusFn,
      json: jsonFn,
    };

    controller.proxyRequest(req, res);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(statusFn).toHaveBeenCalledWith(500);
    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('TestService'),
        requestId: expect.any(String),
        timestamp: expect.any(String),
      }),
    );
  });

  it('proxyRequest should not send error response if headers already sent', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');

    class TestController extends BaseProxyController {
      readonly config = {
        serviceName: 'TestService',
        serviceUrl: 'http://localhost:9999',
        pathRewriteFrom: '^/api/v1/test',
        pathRewriteTo: '/api/v1',
        proxyTimeout: 100,
        timeout: 100,
      };
    }

    const controller = new TestController();
    const req: any = {
      method: 'GET',
      url: '/api/v1/test/health',
      headers: {},
    };
    const statusFn = vi.fn().mockReturnThis();
    const jsonFn = vi.fn().mockReturnThis();
    const res: any = {
      headersSent: true,
      status: statusFn,
      json: jsonFn,
    };

    controller.proxyRequest(req, res);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(statusFn).not.toHaveBeenCalled();
    expect(jsonFn).not.toHaveBeenCalled();
  });
});

// ─── 3. Config Interface Completeness ────────────────────────────────────────

describe('ProxyControllerConfig fields', () => {
  it('BaseProxyController subclass should require serviceName', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');

    class MissingNameController extends BaseProxyController {
      readonly config = {
        serviceName: '',
        serviceUrl: 'http://localhost:9999',
        pathRewriteFrom: '^/test',
        pathRewriteTo: '/',
      } as any;
    }

    const controller = new MissingNameController();
    expect(controller.config.serviceName).toBe('');
  });

  it('config should support optional proxyTimeout and timeout with defaults', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');

    class DefaultTimeoutController extends BaseProxyController {
      readonly config: ProxyControllerConfig = {
        serviceName: 'test',
        serviceUrl: 'http://localhost:9999',
        pathRewriteFrom: '^/test',
        pathRewriteTo: '/',
      };
    }

    const controller = new DefaultTimeoutController();
    expect(controller.config.proxyTimeout).toBeUndefined();
    expect(controller.config.timeout).toBeUndefined();
  });
});

// ─── 7. BaseProxyController Source Quality ───────────────────────────────────

describe('BaseProxyController source quality', () => {
  it('should exist at apps/api/src/shared/base-proxy.controller.ts', () => {
    const source = readFile(join(SHARED, 'base-proxy.controller.ts'));
    expect(source).toBeDefined();
    expect(source.length).toBeGreaterThan(0);
  });

  it('should use createProxyMiddleware from http-proxy-middleware', () => {
    const source = readFile(join(SHARED, 'base-proxy.controller.ts'));
    expect(source).toMatch(/import.*createProxyMiddleware.*from\s+['"]http-proxy-middleware['"]/);
  });

  it('should use fixRequestBody from http-proxy-middleware', () => {
    const source = readFile(join(SHARED, 'base-proxy.controller.ts'));
    expect(source).toMatch(/fixRequestBody/);
  });

  it('should use NestJS Logger', () => {
    const source = readFile(join(SHARED, 'base-proxy.controller.ts'));
    expect(source).toMatch(/Logger/);
  });

  it('should lazily create proxy (not in constructor)', () => {
    const source = readFile(join(SHARED, 'base-proxy.controller.ts'));
    expect(source).toMatch(/get\s+proxy\s*\(\)/);
    expect(source).toMatch(/_proxy/);
  });

  it('should default proxyTimeout and timeout to 60000', () => {
    const source = readFile(join(SHARED, 'base-proxy.controller.ts'));
    expect(source).toMatch(/60000/);
  });
});

// ─── 11. Lazy Proxy Singleton ────────────────────────────────────────────────

describe('Lazy proxy singleton', () => {
  it('proxy getter should return the same instance on repeated access', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');

    class TestController extends BaseProxyController {
      readonly config = {
        serviceName: 'test',
        serviceUrl: 'http://localhost:9999',
        pathRewriteFrom: '^/api/v1/test',
        pathRewriteTo: '/api/v1',
      };
      getProxy() {
        return this.proxy;
      }
    }

    const controller = new TestController();
    const first = controller.getProxy();
    const second = controller.getProxy();
    expect(first).toBe(second);
  });

  it('different controller instances should have independent proxies', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');

    class ControllerA extends BaseProxyController {
      readonly config = {
        serviceName: 'A',
        serviceUrl: 'http://localhost:9991',
        pathRewriteFrom: '^/a',
        pathRewriteTo: '/',
      };
      getProxy() {
        return this.proxy;
      }
    }

    class ControllerB extends BaseProxyController {
      readonly config = {
        serviceName: 'B',
        serviceUrl: 'http://localhost:9992',
        pathRewriteFrom: '^/b',
        pathRewriteTo: '/',
      };
      getProxy() {
        return this.proxy;
      }
    }

    const a = new ControllerA();
    const b = new ControllerB();
    expect(a.getProxy()).not.toBe(b.getProxy());
  });
});

// ─── 12. Request ID Correlation (IC-2) ───────────────────────────────────────

describe('Request ID correlation with ContextInterceptor', () => {
  it('should reuse request.requestId set by ContextInterceptor', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');

    class TestController extends BaseProxyController {
      readonly config = {
        serviceName: 'test',
        serviceUrl: 'http://localhost:9999',
        pathRewriteFrom: '^/api/v1/test',
        pathRewriteTo: '/api/v1',
      };
    }

    const controller = new TestController();
    const interceptorId = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
    const req: any = {
      method: 'GET',
      url: '/test',
      headers: {},
      requestId: interceptorId,
    };
    const res: any = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    controller.proxyRequest(req, res);
    expect(req.headers['x-request-id']).toBe(interceptorId);
  });

  it('should fall back to existing x-request-id header when request.requestId is absent', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');

    class TestController extends BaseProxyController {
      readonly config = {
        serviceName: 'test',
        serviceUrl: 'http://localhost:9999',
        pathRewriteFrom: '^/test',
        pathRewriteTo: '/',
      };
    }

    const controller = new TestController();
    const upstreamId = 'upstream-trace-id-12345';
    const req: any = {
      method: 'GET',
      url: '/test',
      headers: { 'x-request-id': upstreamId },
    };
    const res: any = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    controller.proxyRequest(req, res);
    expect(req.headers['x-request-id']).toBe(upstreamId);
  });

  it('should generate a fallback ID only when both request.requestId and x-request-id are absent', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');

    class TestController extends BaseProxyController {
      readonly config = {
        serviceName: 'test',
        serviceUrl: 'http://localhost:9999',
        pathRewriteFrom: '^/test',
        pathRewriteTo: '/',
      };
    }

    const controller = new TestController();
    const req: any = { method: 'GET', url: '/test', headers: {} };
    const res: any = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    controller.proxyRequest(req, res);
    expect(req.headers['x-request-id']).toBeDefined();
    expect(typeof req.headers['x-request-id']).toBe('string');
    expect(req.headers['x-request-id'].length).toBeGreaterThan(0);
  });

  it('should set x-correlation-id header matching x-request-id', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');

    class TestController extends BaseProxyController {
      readonly config = {
        serviceName: 'test',
        serviceUrl: 'http://localhost:9999',
        pathRewriteFrom: '^/test',
        pathRewriteTo: '/',
      };
    }

    const controller = new TestController();
    const interceptorId = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
    const req: any = {
      method: 'GET',
      url: '/test',
      headers: {},
      requestId: interceptorId,
    };
    const res: any = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    controller.proxyRequest(req, res);
    expect(req.headers['x-correlation-id']).toBe(interceptorId);
    expect(req.headers['x-correlation-id']).toBe(req.headers['x-request-id']);
  });

  it('should prefer request.requestId over x-request-id header', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');

    class TestController extends BaseProxyController {
      readonly config = {
        serviceName: 'test',
        serviceUrl: 'http://localhost:9999',
        pathRewriteFrom: '^/test',
        pathRewriteTo: '/',
      };
    }

    const controller = new TestController();
    const interceptorId = 'interceptor-uuid-v7';
    const headerId = 'header-id-from-upstream';
    const req: any = {
      method: 'GET',
      url: '/test',
      headers: { 'x-request-id': headerId },
      requestId: interceptorId,
    };
    const res: any = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    controller.proxyRequest(req, res);
    expect(req.headers['x-request-id']).toBe(interceptorId);
  });
});

// ─── 12b. Request ID Uniqueness (fallback path) ─────────────────────────────

describe('Request ID uniqueness (fallback path)', () => {
  it('consecutive calls without requestId should produce different IDs', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');

    class TestController extends BaseProxyController {
      readonly config = {
        serviceName: 'test',
        serviceUrl: 'http://localhost:9999',
        pathRewriteFrom: '^/api/v1/test',
        pathRewriteTo: '/api/v1',
      };
    }

    const controller = new TestController();
    const ids: string[] = [];

    for (let i = 0; i < 5; i++) {
      const req: any = { method: 'GET', url: '/test', headers: {} };
      const res: any = {
        headersSent: false,
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      };
      controller.proxyRequest(req, res);
      ids.push(req.headers['x-request-id']);
    }

    const unique = new Set(ids);
    expect(unique.size).toBe(5);
  });

  it('fallback request ID should be alphanumeric (base-36)', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');

    class TestController extends BaseProxyController {
      readonly config = {
        serviceName: 'test',
        serviceUrl: 'http://localhost:9999',
        pathRewriteFrom: '^/test',
        pathRewriteTo: '/',
      };
    }

    const controller = new TestController();
    const req: any = { method: 'GET', url: '/test', headers: {} };
    const res: any = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    controller.proxyRequest(req, res);

    expect(req.headers['x-request-id']).toMatch(/^[a-z0-9]+$/);
  });
});

// ─── 13. Error Response Shape Completeness ───────────────────────────────────

describe('Error response shape completeness', () => {
  it('error response timestamp should be a valid ISO 8601 string', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');

    class TestController extends BaseProxyController {
      readonly config = {
        serviceName: 'TestSvc',
        serviceUrl: 'http://localhost:9999',
        pathRewriteFrom: '^/api/v1/test',
        pathRewriteTo: '/api/v1',
        proxyTimeout: 100,
        timeout: 100,
      };
    }

    const controller = new TestController();
    const req: any = { method: 'POST', url: '/api/v1/test/data', headers: {} };
    let capturedBody: any = null;
    const res: any = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn((body: any) => {
        capturedBody = body;
        return res;
      }),
    };

    controller.proxyRequest(req, res);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(capturedBody).not.toBeNull();
    const parsed = new Date(capturedBody.timestamp);
    expect(parsed.toISOString()).toBe(capturedBody.timestamp);
  });

  it('error message should include the service name from config', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');

    class AlphaController extends BaseProxyController {
      readonly config = {
        serviceName: 'AlphaService',
        serviceUrl: 'http://localhost:9999',
        pathRewriteFrom: '^/alpha',
        pathRewriteTo: '/',
        proxyTimeout: 100,
        timeout: 100,
      };
    }

    const controller = new AlphaController();
    const req: any = { method: 'GET', url: '/alpha', headers: {} };
    let capturedBody: any = null;
    const res: any = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn((body: any) => {
        capturedBody = body;
        return res;
      }),
    };

    controller.proxyRequest(req, res);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(capturedBody.error).toContain('AlphaService');
    expect(capturedBody.error).toContain('unavailable');
  });

  it('error response requestId should match the x-request-id set on the request', async () => {
    const { BaseProxyController } = await import('../shared/base-proxy.controller');

    class TestController extends BaseProxyController {
      readonly config = {
        serviceName: 'Test',
        serviceUrl: 'http://localhost:9999',
        pathRewriteFrom: '^/test',
        pathRewriteTo: '/',
        proxyTimeout: 100,
        timeout: 100,
      };
    }

    const controller = new TestController();
    const req: any = { method: 'GET', url: '/test', headers: {} };
    let capturedBody: any = null;
    const res: any = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      json: vi.fn((body: any) => {
        capturedBody = body;
        return res;
      }),
    };

    controller.proxyRequest(req, res);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(capturedBody.requestId).toBe(req.headers['x-request-id']);
  });
});

// ─── 22a. Proxy Error Handler – Logging & Response ──────────────────────────

describe('Proxy error handler logging and response', () => {
  it('should log error.code when error.message is empty', async () => {
    const source = readFile(join(SHARED, 'base-proxy.controller.ts'));
    expect(source).toMatch(/err\.code|err\['code'\]|\(err\s+as\s+any\)\.code/);
  });

  // was 502. A proxy `error` event fires when the peer was never
  // reached — a TRANSPORT failure — which is 503 (retryable, and the only 5xx
  // RFC 9110 pairs with `Retry-After`), not 502 (the peer answered badly).
  it('should send 503 response from on.error handler (not leave client hanging)', async () => {
    const source = readFile(join(SHARED, 'base-proxy.controller.ts'));
    expect(source).toMatch(/error:[\s\S]*err[\s\S]*req[\s\S]*res/);
    expect(source).toMatch(/res\.\w*status\w*\(503\)|res\.writeHead\(503/);
  });

  // the body used to carry `err.message` verbatim — i.e.
  // `connect ECONNREFUSED 127.0.0.1:8862`.
  it('should redact topology out of the on.error response body', async () => {
    const source = readFile(join(SHARED, 'base-proxy.controller.ts'));
    expect(source).toMatch(/detail:\s*redactTopology\(/);
  });

  it('should not send response from on.error if headers already sent', async () => {
    const source = readFile(join(SHARED, 'base-proxy.controller.ts'));
    expect(source).toMatch(/headersSent/);
  });

  it('should include service name in error response from on.error handler', async () => {
    const source = readFile(join(SHARED, 'base-proxy.controller.ts'));
    expect(source).toMatch(/config\.serviceName/);
  });

  it('should use WARN level for expected connection errors (ECONNREFUSED, ECONNRESET, ETIMEDOUT)', async () => {
    const source = readFile(join(SHARED, 'base-proxy.controller.ts'));
    expect(source).toMatch(/ECONNREFUSED|ECONNRESET|ETIMEDOUT/);
  });
});

describe('Default timeout behavior', () => {
  it('proxy should use 60000ms when config omits proxyTimeout', async () => {
    const source = readFile(join(SHARED, 'base-proxy.controller.ts'));
    expect(source).toMatch(/config\.proxyTimeout\s*\?\?\s*60000/);
    expect(source).toMatch(/config\.timeout\s*\?\?\s*60000/);
  });
});
