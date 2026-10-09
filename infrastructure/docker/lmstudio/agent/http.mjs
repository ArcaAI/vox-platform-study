// =============================================================================
// HTTP skin of the LM Studio residency agent (node:http, zero dependencies)
// =============================================================================
//   GET  /health                                  readiness: the daemon greets
//   GET  /internal/residency                      the report
//   POST /internal/residency/load
//   POST /internal/residency/unload
//   PUT  /internal/residency/models/{ref}/policy  ref percent-encoded, may hold '/'
//
// Bodies are the python agent's (residency_api.py), validated as strictly as
// its pydantic models (`extra="forbid"`): an unknown field is a 422, not
// something to ignore — ignoring is exactly the failure mode the kvConfig
// read-back exists to catch one layer down.
//
// Auth: `X-Service-Token` must equal INTERNAL_ACCESS_TOKEN (constant-time);
// an EMPTY token is the dev bypass, as on the python services. /health is
// exempt so a kubelet probe needs no secret. In a DEPLOYED process
// (`deployed`, see server.mjs isDeployed) an empty token is NOT a bypass: every
// /internal route answers 503 AUTH_NOT_CONFIGURED (R2-F9, TASK-892 C3) — an
// agent that loads and unloads models on anyone's say-so is the failure, and a
// loud refusal is the only honest answer to a missing secret.
//
// Unlike LM Studio's own server (which answers 200 for unknown paths), every
// status here means what it says, so an httpGet probe on /health is valid.
// =============================================================================
import { createHash, timingSafeEqual } from 'node:crypto';

import { ResidencyError } from './residency.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const DEVICE = /^(cuda:\d+|cpu)$/;
const POLICY_PATH = /^\/internal\/residency\/models\/(.+)\/policy$/;

class RequestError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

const invalid = (message, field) => new RequestError(422, 'INVALID_REQUEST', message, field);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const digest = (value) => createHash('sha256').update(String(value), 'utf8').digest();

/** Constant-time over equal-length digests, so neither content nor length leaks. */
export const tokenMatches = (presented, expected) =>
  typeof presented === 'string' && timingSafeEqual(digest(presented), digest(expected));

// ── body schemas (mirroring residency_api.py) ─────────────────────────────────

const strict = (body, allowed) => {
  if (!isObject(body)) throw invalid('expected a JSON object');
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw invalid(`unknown field(s): ${unknown.join(', ')}`, unknown[0]);
};

const modelRefOf = (body) => {
  if (typeof body.model_ref !== 'string' || body.model_ref.length === 0) {
    throw invalid('model_ref must be a non-empty string', 'model_ref');
  }
  return body.model_ref;
};

const boolOf = (body, key, fallback) => {
  if (!(key in body)) return fallback;
  if (typeof body[key] !== 'boolean') throw invalid(`${key} must be a boolean`, key);
  return body[key];
};

const ttlOf = (body) => {
  if (!('ttl_seconds' in body) || body.ttl_seconds === null) return null;
  if (!Number.isSafeInteger(body.ttl_seconds) || body.ttl_seconds < 1) {
    throw invalid('ttl_seconds must be a positive integer or null', 'ttl_seconds');
  }
  return body.ttl_seconds;
};

const deviceOf = (body) => {
  if (!('device' in body) || body.device === null) return null;
  if (typeof body.device !== 'string' || !DEVICE.test(body.device)) {
    throw invalid('device must be cuda:<n>, cpu or null', 'device');
  }
  return body.device;
};

export function parseLoadBody(body) {
  strict(body, ['model_ref', 'load_spec', 'pin', 'ttl_seconds', 'device']);
  const loadSpec = 'load_spec' in body ? body.load_spec : {};
  if (!isObject(loadSpec)) throw invalid('load_spec must be an object', 'load_spec');
  return {
    model_ref: modelRefOf(body),
    load_spec: loadSpec,
    pin: boolOf(body, 'pin', false),
    ttl_seconds: ttlOf(body),
    device: deviceOf(body),
  };
}

export function parseUnloadBody(body) {
  strict(body, ['model_ref', 'force', 'reason', 'device']);
  const reason = 'reason' in body ? body.reason : 'admin';
  if (reason !== 'admin' && reason !== 'policy') throw invalid('reason must be "admin" or "policy"', 'reason');
  return { model_ref: modelRefOf(body), force: boolOf(body, 'force', false), reason, device: deviceOf(body) };
}

export function parsePolicyBody(body) {
  strict(body, ['admin_pinned', 'ttl_seconds']);
  const out = {};
  if ('admin_pinned' in body) {
    if (body.admin_pinned !== null && typeof body.admin_pinned !== 'boolean') {
      throw invalid('admin_pinned must be a boolean or null', 'admin_pinned');
    }
    out.admin_pinned = body.admin_pinned;
  }
  // An ABSENT field is left as it is; `ttl_seconds: null` resets to the default.
  if ('ttl_seconds' in body) out.ttl_seconds = ttlOf(body);
  return out;
}

// ── plumbing ──────────────────────────────────────────────────────────────────

const send = (res, status, payload) => {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

const readJson = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true; // keep draining so the client gets the 413, not a reset
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (tooLarge) return reject(new RequestError(413, 'INVALID_REQUEST', `body exceeds ${MAX_BODY_BYTES} bytes`));
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new RequestError(400, 'INVALID_REQUEST', 'body is not valid JSON'));
      }
    });
  });

/** Which route a path is, so 404 vs 405 is answered without running anything. */
const routeOf = (path) => {
  if (path === '/health') return { name: 'health', methods: ['GET'] };
  if (path === '/internal/residency') return { name: 'report', methods: ['GET'] };
  if (path === '/internal/residency/load') return { name: 'load', methods: ['POST'] };
  if (path === '/internal/residency/unload') return { name: 'unload', methods: ['POST'] };
  const policy = POLICY_PATH.exec(path);
  if (policy) return { name: 'policy', methods: ['PUT'], ref: policy[1] };
  return null;
};

const FALLBACK_CODE = { load: 'LOAD_FAILED', unload: 'UNLOAD_FAILED' };

const AUTH_NOT_CONFIGURED_MESSAGE =
  'INTERNAL_ACCESS_TOKEN is unset, empty or the CHANGE_ME placeholder in a deployed environment ' +
  '(DEPLOYMENT_ENVIRONMENT / NODE_ENV=production): every /internal route is refused instead of ' +
  'running unauthenticated. Set the shared internal token; an EMPTY value is not a dev bypass here.';

/**
 * @param {{ agent: object, token: string, deployed?: boolean, log: (level, event, fields) => void }} deps
 *   `token` is the REAL secret ('' when absent or the placeholder); `deployed`
 *   turns an empty token from the dev bypass into a refusal.
 * @returns {(req, res) => void} a node:http request listener
 */
export function createHandler({ agent, token, deployed = false, log = () => {} }) {
  const expected = typeof token === 'string' ? token : '';
  const refuseAll = deployed === true && expected === '';
  if (refuseAll) log('error', 'agent.auth_not_configured', { message: AUTH_NOT_CONFIGURED_MESSAGE });

  return async function handle(req, res) {
    const started = Date.now();
    const path = (req.url ?? '/').split('?')[0];
    let status = 500;
    const reply = (code, payload) => {
      status = code;
      send(res, code, payload);
    };

    const route = routeOf(path);
    try {
      if (!route) return reply(404, { error: { code: 'NOT_FOUND', message: `no route ${path}` } });
      if (!route.methods.includes(req.method)) {
        res.setHeader('allow', route.methods.join(', '));
        return reply(405, { error: { code: 'METHOD_NOT_ALLOWED', message: `${req.method} ${path}` } });
      }

      if (route.name === 'health') {
        const up = await agent.healthy();
        return reply(up ? 200 : 503, { status: up ? 'ok' : 'unavailable', daemon: up ? 'up' : 'down' });
      }

      if (refuseAll) {
        return reply(503, { error: { code: 'AUTH_NOT_CONFIGURED', message: AUTH_NOT_CONFIGURED_MESSAGE } });
      }
      if (expected !== '' && !tokenMatches(req.headers['x-service-token'], expected)) {
        return reply(401, { detail: 'Invalid or missing service token' });
      }

      switch (route.name) {
        case 'report':
          return reply(200, await agent.report());
        case 'load':
          return reply(200, await agent.load(parseLoadBody(await readJson(req))));
        case 'unload':
          return reply(200, await agent.unload(parseUnloadBody(await readJson(req))));
        case 'policy': {
          let ref;
          try {
            ref = decodeURIComponent(route.ref);
          } catch {
            throw invalid('model ref in the path is not valid percent-encoding');
          }
          return reply(200, await agent.setPolicy(ref, parsePolicyBody(await readJson(req))));
        }
        default:
          return reply(404, { error: { code: 'NOT_FOUND', message: path } });
      }
    } catch (error) {
      if (error instanceof ResidencyError) return reply(error.status ?? 500, error.body());
      if (error instanceof RequestError) {
        return reply(error.status, {
          error: { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) },
        });
      }
      log('error', 'residency.unhandled', { route: route?.name, reason: String(error?.stack ?? error) });
      return reply(500, {
        error: { code: FALLBACK_CODE[route?.name] ?? 'INTERNAL_ERROR', message: String(error?.message ?? error) },
      });
    } finally {
      log(status >= 500 ? 'warn' : 'info', 'http.request', {
        method: req.method,
        path: route?.name === 'policy' ? '/internal/residency/models/{ref}/policy' : path,
        status,
        duration_ms: Date.now() - started,
      });
    }
  };
}
