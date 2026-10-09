// The HTTP skin over a REAL node:http server on an ephemeral loopback port, with
// a fake agent behind it. Routes, auth, strict bodies, error mapping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createHandler } from './http.mjs';
import { ResidencyError } from './residency.mjs';

const TOKEN = 'svc-token-123';

function fakeAgent() {
  const calls = [];
  return {
    calls,
    healthyValue: true,
    async healthy() {
      return this.healthyValue;
    },
    async report() {
      calls.push(['report']);
      return { service: 'lm-studio', instance: 'i', reported_at: 'x', devices: [], models: [] };
    },
    async load(body) {
      calls.push(['load', body]);
      if (body.model_ref === 'busy') {
        throw new ResidencyError('LOAD_IN_PROGRESS', 'busy', { status: 409 });
      }
      if (body.model_ref === 'boom') throw new Error('unexpected');
      return { outcome: 'loaded', model: { model_ref: body.model_ref } };
    },
    async unload(body) {
      calls.push(['unload', body]);
      return { outcome: 'unloaded', model_ref: body.model_ref };
    },
    async ensure(body) {
      calls.push(['ensure', body]);
      if (body.model_ref === 'x') {
        throw new ResidencyError('MODEL_UNKNOWN', "no serving profile for 'x' in the LM Studio plan", { status: 404 });
      }
      if (body.model_ref === 'oom') {
        throw new ResidencyError('LOAD_FAILED', 'out of memory', { status: 503 });
      }
      return { outcome: 'loaded', model_ref: body.model_ref, identifier: body.model_ref, load_seconds: 21.4 };
    },
    async setPolicy(ref, body) {
      calls.push(['policy', ref, body]);
      return { model: { model_ref: ref } };
    },
  };
}

async function withServer(options, fn) {
  const agent = options.agent ?? fakeAgent();
  const logs = [];
  const server = createServer(
    createHandler({ agent, token: options.token ?? TOKEN, log: (level, event, fields) => logs.push({ level, event, ...fields }) }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, agent, logs });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const call = async (base, path, { method = 'GET', body, token = TOKEN, raw } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token !== null) headers['x-service-token'] = token;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
};

test('GET /health is 200 when the daemon greets, 503 when not — and needs no token', async () => {
  await withServer({}, async ({ base, agent }) => {
    assert.deepEqual(await call(base, '/health', { token: null }), { status: 200, json: { status: 'ok', daemon: 'up' } });
    agent.healthyValue = false;
    const down = await call(base, '/health', { token: null });
    assert.equal(down.status, 503);
    assert.equal(down.json.daemon, 'down');
  });
});

test('every /internal route needs the X-Service-Token; a wrong or missing one is 401', async () => {
  await withServer({}, async ({ base, agent }) => {
    assert.equal((await call(base, '/internal/residency', { token: null })).status, 401);
    assert.equal((await call(base, '/internal/residency', { token: 'wrong' })).status, 401);
    assert.equal((await call(base, '/internal/residency', { token: `${TOKEN}x` })).status, 401);
    assert.equal(agent.calls.length, 0);
    assert.equal((await call(base, '/internal/residency')).status, 200);
  });
});

test('an empty INTERNAL_ACCESS_TOKEN is the dev bypass, as on the python services', async () => {
  await withServer({ token: '' }, async ({ base }) => {
    assert.equal((await call(base, '/internal/residency', { token: null })).status, 200);
  });
});

test('GET /internal/residency answers the agent report', async () => {
  await withServer({}, async ({ base }) => {
    const { status, json } = await call(base, '/internal/residency');
    assert.equal(status, 200);
    assert.equal(json.service, 'lm-studio');
  });
});

test('POST /internal/residency/load passes the contract body with defaults filled', async () => {
  await withServer({}, async ({ base, agent }) => {
    const { status, json } = await call(base, '/internal/residency/load', {
      method: 'POST',
      body: { model_ref: 'gemma-4-e2b-it-qat', device: 'cuda:1' },
    });
    assert.equal(status, 200);
    assert.equal(json.outcome, 'loaded');
    assert.deepEqual(agent.calls[0], [
      'load',
      { model_ref: 'gemma-4-e2b-it-qat', load_spec: {}, pin: false, ttl_seconds: null, device: 'cuda:1' },
    ]);
  });
});

test('load bodies are strict: unknown fields, bad types and bad device ids are 422', async () => {
  await withServer({}, async ({ base, agent }) => {
    for (const body of [
      {},
      { model_ref: '' },
      { model_ref: 'x', extra: 1 },
      { model_ref: 'x', pin: 'yes' },
      { model_ref: 'x', ttl_seconds: 0 },
      { model_ref: 'x', ttl_seconds: 1.5 },
      { model_ref: 'x', device: 'gpu1' },
      { model_ref: 'x', load_spec: [] },
    ]) {
      const { status, json } = await call(base, '/internal/residency/load', { method: 'POST', body });
      assert.equal(status, 422, JSON.stringify(body));
      assert.equal(json.error.code, 'INVALID_REQUEST');
    }
    assert.equal(agent.calls.length, 0);
  });
});

test('malformed JSON is 400; a non-object body is 422', async () => {
  await withServer({}, async ({ base }) => {
    assert.equal((await call(base, '/internal/residency/load', { method: 'POST', raw: '{nope' })).status, 400);
    assert.equal((await call(base, '/internal/residency/load', { method: 'POST', raw: '[1]' })).status, 422);
  });
});

test('a ResidencyError keeps its status and contract body; anything else is a 500 LOAD_FAILED', async () => {
  await withServer({}, async ({ base, logs }) => {
    const busy = await call(base, '/internal/residency/load', { method: 'POST', body: { model_ref: 'busy' } });
    assert.equal(busy.status, 409);
    assert.deepEqual(busy.json, { error: { code: 'LOAD_IN_PROGRESS', message: 'busy' } });
    const boom = await call(base, '/internal/residency/load', { method: 'POST', body: { model_ref: 'boom' } });
    assert.equal(boom.status, 500);
    assert.equal(boom.json.error.code, 'LOAD_FAILED');
    assert.ok(logs.some((l) => l.level === 'error' && l.event === 'residency.unhandled'));
  });
});

test('POST /internal/residency/unload: defaults force=false, reason=admin; strict like load', async () => {
  await withServer({}, async ({ base, agent }) => {
    const ok = await call(base, '/internal/residency/unload', { method: 'POST', body: { model_ref: 'x' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(agent.calls[0], ['unload', { model_ref: 'x', force: false, reason: 'admin', device: null }]);
    assert.equal((await call(base, '/internal/residency/unload', { method: 'POST', body: { model_ref: 'x', reason: 'bored' } })).status, 422);
    assert.equal((await call(base, '/internal/residency/unload', { method: 'POST', body: { model_ref: 'x', force: 1 } })).status, 422);
  });
});

test('PUT /internal/residency/models/{ref}/policy decodes a ref with slashes; absent fields stay absent', async () => {
  await withServer({}, async ({ base, agent }) => {
    const ref = encodeURIComponent('org/model');
    const { status } = await call(base, `/internal/residency/models/${ref}/policy`, { method: 'PUT', body: { admin_pinned: true } });
    assert.equal(status, 200);
    assert.deepEqual(agent.calls[0], ['policy', 'org/model', { admin_pinned: true }]);
    await call(base, '/internal/residency/models/org/model/policy', { method: 'PUT', body: { ttl_seconds: null } });
    assert.deepEqual(agent.calls[1], ['policy', 'org/model', { ttl_seconds: null }]);
    assert.equal((await call(base, `/internal/residency/models/${ref}/policy`, { method: 'PUT', body: { pinned: true } })).status, 422);
  });
});

test('unknown paths are 404, wrong methods 405', async () => {
  await withServer({}, async ({ base }) => {
    assert.equal((await call(base, '/internal/nope')).status, 404);
    assert.equal((await call(base, '/internal/residency/load')).status, 405);
    assert.equal((await call(base, '/internal/residency', { method: 'POST', body: {} })).status, 405);
  });
});

test('a body over the size limit is 413 and never reaches the agent', async () => {
  await withServer({}, async ({ base, agent }) => {
    const raw = JSON.stringify({ model_ref: 'x', load_spec: { identifier: 'y'.repeat(300_000) } });
    assert.equal((await call(base, '/internal/residency/load', { method: 'POST', raw })).status, 413);
    assert.equal(agent.calls.length, 0);
  });
});

test('every request writes one access log line without the token', async () => {
  await withServer({}, async ({ base, logs }) => {
    await call(base, '/internal/residency');
    const line = logs.find((l) => l.event === 'http.request');
    assert.equal(line.method, 'GET');
    assert.equal(line.path, '/internal/residency');
    assert.equal(line.status, 200);
    assert.ok(!JSON.stringify(logs).includes(TOKEN));
  });
});

// ── R2-F9: fail CLOSED when deployed with no usable token ─────────────────────

async function withDeployedServer({ token }, fn) {
  const agent = fakeAgent();
  const logs = [];
  const server = createServer(
    createHandler({ agent, token, deployed: true, log: (level, event, fields) => logs.push({ level, event, ...fields }) }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn({ base: `http://127.0.0.1:${server.address().port}`, agent, logs });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('deployed + empty token: EVERY /internal route is refused 503 AUTH_NOT_CONFIGURED; /health stays open', async () => {
  await withDeployedServer({ token: '' }, async ({ base, agent, logs }) => {
    assert.ok(
      logs.some((l) => l.level === 'error' && l.event === 'agent.auth_not_configured'),
      'one loud line when the handler is built',
    );
    for (const [path, method, body] of [
      ['/internal/residency', 'GET'],
      ['/internal/residency/load', 'POST', { model_ref: 'x' }],
      ['/internal/residency/unload', 'POST', { model_ref: 'x' }],
      ['/internal/residency/models/x/policy', 'PUT', { admin_pinned: true }],
    ]) {
      for (const token of [null, '', 'CHANGE_ME', 'anything']) {
        const { status, json } = await call(base, path, { method, body, token });
        assert.equal(status, 503, `${method} ${path} with token ${JSON.stringify(token)}`);
        assert.equal(json.error.code, 'AUTH_NOT_CONFIGURED');
        assert.match(json.error.message, /INTERNAL_ACCESS_TOKEN/);
      }
    }
    assert.equal(agent.calls.length, 0, 'nothing reaches the agent');
    assert.equal((await call(base, '/health', { token: null })).status, 200);
    assert.ok(logs.some((l) => l.event === 'http.request' && l.status === 503));
  });
});

test('deployed + a real token: the normal gate (401 without it, 200 with it)', async () => {
  await withDeployedServer({ token: TOKEN }, async ({ base, logs }) => {
    assert.equal((await call(base, '/internal/residency', { token: null })).status, 401);
    assert.equal((await call(base, '/internal/residency')).status, 200);
    assert.ok(!logs.some((l) => l.event === 'agent.auth_not_configured'));
  });
});

test('GET /metrics needs no token, is the Prometheus text format, and is served even when /internal is refused', async () => {
  const agent = fakeAgent();
  agent.metrics = async () => '# TYPE model_evictions_total counter\n';
  const server = createServer(createHandler({ agent, token: '', deployed: true }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/metrics`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8');
    assert.equal(await response.text(), '# TYPE model_evictions_total counter\n');
    assert.equal((await fetch(`${base}/metrics`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/internal/residency`)).status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── wave 3: POST /internal/residency/ensure ─────────────────────────────────

test('POST /internal/residency/ensure answers the agent result; errors are the contract FLAT {code, message}', async () => {
  await withServer({}, async ({ base, agent }) => {
    const ok = await call(base, '/internal/residency/ensure', { method: 'POST', body: { model_ref: 'granite-guardian-4.1-8b' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, {
      outcome: 'loaded',
      model_ref: 'granite-guardian-4.1-8b',
      identifier: 'granite-guardian-4.1-8b',
      load_seconds: 21.4,
    });
    assert.deepEqual(agent.calls[0], ['ensure', { model_ref: 'granite-guardian-4.1-8b' }]);

    assert.deepEqual(await call(base, '/internal/residency/ensure', { method: 'POST', body: { model_ref: 'x' } }), {
      status: 404,
      json: { code: 'MODEL_UNKNOWN', message: "no serving profile for 'x' in the LM Studio plan" },
    });
    assert.deepEqual(await call(base, '/internal/residency/ensure', { method: 'POST', body: { model_ref: 'oom' } }), {
      status: 503,
      json: { code: 'LOAD_FAILED', message: 'out of memory' },
    });
  });
});

test('ensure needs the X-Service-Token, is POST only, and its body is strict', async () => {
  await withServer({}, async ({ base, agent }) => {
    assert.equal((await call(base, '/internal/residency/ensure', { method: 'POST', body: { model_ref: 'm' }, token: null })).status, 401);
    assert.equal((await call(base, '/internal/residency/ensure')).status, 405);
    for (const body of [{}, { model_ref: '' }, { model_ref: 'm', load_spec: {} }]) {
      const { status, json } = await call(base, '/internal/residency/ensure', { method: 'POST', body });
      assert.equal(status, 422, JSON.stringify(body));
      assert.equal(json.error.code, 'INVALID_REQUEST');
    }
    assert.equal(agent.calls.length, 0);
  });
});

test('deployed + empty token: ensure is refused like every /internal route', async () => {
  await withDeployedServer({ token: '' }, async ({ base }) => {
    const { status } = await call(base, '/internal/residency/ensure', { method: 'POST', body: { model_ref: 'm' } });
    assert.equal(status, 503);
  });
});
