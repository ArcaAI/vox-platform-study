// The wired agent server: env -> port/token, JSON-lines logging, startup
// diagnostics. Daemon and nvidia-smi are injected fakes; the server listens on
// an ephemeral loopback port.
import test from 'node:test';
import assert from 'node:assert/strict';

import { agentConfig, buildAgentServer, createJsonLogger, sdkLogger } from './server.mjs';

test('agentConfig: contract defaults — :8869 on all interfaces, daemon on loopback :1234', () => {
  assert.deepEqual(agentConfig({}), {
    host: '0.0.0.0',
    port: 8869,
    daemonPort: 1234,
    token: '',
    instance: 'hope-lmstudio',
    loadTimeoutMs: 600_000,
  });
  const custom = agentConfig({
    LMS_AGENT_HOST: '127.0.0.1',
    LMS_AGENT_PORT: '9000',
    LMS_PORT: '4321',
    INTERNAL_ACCESS_TOKEN: ' s3cret ',
    HOSTNAME: 'hope-lmstudio-6c8489cfc8-bnxhr',
    LMS_AGENT_LOAD_TIMEOUT_SECONDS: '900',
  });
  assert.equal(custom.port, 9000);
  assert.equal(custom.daemonPort, 4321);
  assert.equal(custom.token, 's3cret');
  assert.equal(custom.instance, 'hope-lmstudio-6c8489cfc8-bnxhr');
  assert.equal(custom.loadTimeoutMs, 900_000);
  assert.throws(() => agentConfig({ LMS_AGENT_PORT: 'abc' }), /LMS_AGENT_PORT/);
});

test('createJsonLogger writes ONE JSON object per line with ts, level, logger and event', () => {
  const lines = [];
  const log = createJsonLogger((text) => lines.push(text), () => Date.parse('2026-10-09T09:00:00.123Z'));
  log('warn', 'residency.load_failed', { model_ref: 'x', reason: 'oom\nline2' });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('\n'));
  assert.equal(lines[0].trimEnd().includes('\n'), false);
  assert.deepEqual(JSON.parse(lines[0]), {
    ts: '2026-10-09T09:00:00.123Z',
    level: 'warn',
    logger: 'lmstudio-agent',
    event: 'residency.load_failed',
    model_ref: 'x',
    reason: 'oom\nline2',
  });
});

test('sdkLogger routes the SDK console into the JSON log and drops debug', () => {
  const seen = [];
  const logger = sdkLogger((level, event, fields) => seen.push({ level, event, ...fields }));
  logger.info('connected', 1);
  logger.warn('retrying');
  logger.error(new Error('boom'));
  logger.debug('noise');
  assert.deepEqual(
    seen.map((s) => [s.level, s.event, s.message]),
    [
      ['info', 'sdk.log', 'connected 1'],
      ['warn', 'sdk.log', 'retrying'],
      ['error', 'sdk.log', 'Error: boom'],
    ],
  );
});

test('buildAgentServer serves /health and the token-gated report off the env token', async () => {
  const lines = [];
  const daemon = {
    greet: async () => true,
    listModels: async () => [],
    listLoaded: async () => [],
    appliedFields: async () => [],
    load: async () => {
      throw new Error('not in this test');
    },
    unload: async () => {},
  };
  const { server, startup } = buildAgentServer({
    env: { INTERNAL_ACCESS_TOKEN: 'tok', HOSTNAME: 'pod-1', CUDA_DEVICE_ORDER: 'PCI_BUS_ID' },
    daemon,
    gpus: { read: async () => [{ index: 0, uuid: 'GPU-a', name: 'Card', usedBytes: 1, freeBytes: 2, totalBytes: 3 }] },
    write: (text) => lines.push(JSON.parse(text)),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/internal/residency`)).status, 401);
    const report = await fetch(`${base}/internal/residency`, { headers: { 'x-service-token': 'tok' } });
    assert.equal(report.status, 200);
    const body = await report.json();
    assert.equal(body.instance, 'pod-1');
    assert.equal(body.devices[0].uuid, 'GPU-a');

    await startup();
    const boot = lines.find((l) => l.event === 'agent.gpus');
    assert.equal(boot.cuda_device_order, 'PCI_BUS_ID');
    assert.deepEqual(boot.gpus, [{ index: 0, uuid: 'GPU-a', name: 'Card' }]);
    assert.ok(!JSON.stringify(lines).includes('tok"'), 'the token is never logged');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('startup warns when CUDA_DEVICE_ORDER is not PCI_BUS_ID (cuda:<n> may not be nvidia-smi index n)', async () => {
  const lines = [];
  const { startup } = buildAgentServer({
    env: {},
    daemon: { greet: async () => true },
    gpus: { read: async () => null },
    write: (text) => lines.push(JSON.parse(text)),
  });
  await startup();
  const warn = lines.find((l) => l.event === 'agent.cuda_device_order');
  assert.equal(warn.level, 'warn');
  assert.equal(lines.find((l) => l.event === 'agent.gpus').gpus, null);
});
