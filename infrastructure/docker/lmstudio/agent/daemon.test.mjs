// The daemon adapter: REST (/lmstudio-greeting, /api/v1/models) + the SDK port
// (listLoaded, getLoadConfig, loadModel, unloadModel). fetch and the SDK client
// are fakes — no socket is opened.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDaemon } from './daemon.mjs';

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function fakeClient({ llmLoaded = [], embeddingLoaded = [], failList = false } = {}) {
  const calls = [];
  const port = (ns, loaded) => ({
    async callRpc(name, params) {
      calls.push([ns, name, params]);
      if (name === 'listLoaded') {
        if (failList) throw new Error('socket closed');
        return loaded;
      }
      if (name === 'getLoadConfig') return { fields: [{ key: 'llm.load.contextLength', value: 4096 }] };
      if (name === 'unloadModel') return undefined;
      throw new Error(`unexpected rpc ${name}`);
    },
    createChannel(name, params, onMessage) {
      calls.push([ns, 'channel', name, params]);
      queueMicrotask(() => onMessage({ type: 'success', info: { identifier: params.identifier, modelKey: params.modelKey, instanceReference: 'r9', sizeBytes: 5 } }));
      return { onError: { subscribeOnce() {} } };
    },
  });
  return {
    calls,
    disposed: 0,
    llm: { port: port('llm', llmLoaded) },
    embedding: { port: port('embedding', embeddingLoaded) },
    async [Symbol.asyncDispose]() {
      this.disposed += 1;
    },
  };
}

const INFO = {
  type: 'llm',
  identifier: 'gemma-4-e2b-it-qat',
  modelKey: 'gemma-4-e2b-it-qat@q4_0',
  instanceReference: 'r1',
  sizeBytes: 3_350_000_000,
  contextLength: 65536,
  displayName: 'Gemma',
};

test('greet: true only for {"lmstudio": true} — a 200 alone proves nothing on this server', async () => {
  const urls = [];
  const daemon = createDaemon({
    port: 1234,
    fetchImpl: async (url) => {
      urls.push(url);
      return jsonResponse(200, { lmstudio: true });
    },
    connect: async () => fakeClient(),
  });
  assert.equal(await daemon.greet(), true);
  assert.equal(urls[0], 'http://127.0.0.1:1234/lmstudio-greeting');
  const lying = createDaemon({ port: 1, fetchImpl: async () => jsonResponse(200, { error: 'Unexpected endpoint' }), connect: async () => fakeClient() });
  assert.equal(await lying.greet(), false);
});

test('listModels reads `models` (or `data`) from /api/v1/models; a non-2xx throws', async () => {
  const daemon = createDaemon({ port: 1234, fetchImpl: async () => jsonResponse(200, { models: [{ key: 'a@q4', type: 'llm' }] }), connect: async () => fakeClient() });
  assert.deepEqual(await daemon.listModels(), [{ key: 'a@q4', type: 'llm' }]);
  const data = createDaemon({ port: 1234, fetchImpl: async () => jsonResponse(200, { data: [{ key: 'b' }] }), connect: async () => fakeClient() });
  assert.deepEqual(await data.listModels(), [{ key: 'b' }]);
  const bad = createDaemon({ port: 1234, fetchImpl: async () => jsonResponse(500, {}), connect: async () => fakeClient() });
  await assert.rejects(bad.listModels(), /HTTP 500/);
});

test('listLoaded lists llm AND embedding instances, trimmed to the fields the agent uses', async () => {
  const client = fakeClient({ llmLoaded: [INFO], embeddingLoaded: [{ ...INFO, type: 'embedding', identifier: 'emb', modelKey: 'emb', instanceReference: 'r2' }] });
  const daemon = createDaemon({ port: 1234, fetchImpl: async () => jsonResponse(200, {}), connect: async () => client });
  const loaded = await daemon.listLoaded();
  assert.deepEqual(loaded, [
    { type: 'llm', identifier: 'gemma-4-e2b-it-qat', modelKey: 'gemma-4-e2b-it-qat@q4_0', instanceReference: 'r1', sizeBytes: 3_350_000_000 },
    { type: 'embedding', identifier: 'emb', modelKey: 'emb', instanceReference: 'r2', sizeBytes: 3_350_000_000 },
  ]);
});

test('the SDK client is opened once and reused; a failed call drops it so the next call reconnects', async () => {
  let opened = 0;
  let client = fakeClient({ failList: true });
  const daemon = createDaemon({
    port: 1234,
    fetchImpl: async () => jsonResponse(200, {}),
    connect: async () => {
      opened += 1;
      return client;
    },
  });
  await assert.rejects(daemon.listLoaded(), /socket closed/);
  assert.equal(client.disposed, 1);
  client = fakeClient({ llmLoaded: [INFO] });
  assert.equal((await daemon.listLoaded()).length, 1);
  await daemon.listLoaded();
  assert.equal(opened, 2);
});

test('appliedFields / unload go to the port of the instance type', async () => {
  const client = fakeClient();
  const daemon = createDaemon({ port: 1234, fetchImpl: async () => jsonResponse(200, {}), connect: async () => client });
  assert.deepEqual(await daemon.appliedFields({ type: 'embedding', instanceReference: 'r2' }), [{ key: 'llm.load.contextLength', value: 4096 }]);
  await daemon.unload({ type: 'llm', identifier: 'gemma-4-e2b-it-qat' });
  assert.deepEqual(client.calls, [
    ['embedding', 'getLoadConfig', { specifier: { type: 'instanceReference', instanceReference: 'r2' } }],
    ['llm', 'unloadModel', { identifier: 'gemma-4-e2b-it-qat' }],
  ]);
});

test('load opens the loadModel channel on the llm port and resolves the instance info', async () => {
  const client = fakeClient();
  const daemon = createDaemon({ port: 1234, fetchImpl: async () => jsonResponse(200, {}), connect: async () => client });
  const info = await daemon.load({ modelKey: 'k@q4', identifier: 'k', ttlMs: undefined, kvConfig: { fields: [] } });
  assert.equal(info.identifier, 'k');
  assert.equal(info.type, 'llm');
  assert.equal(client.calls[0][2], 'loadModel');
});

test('load gives up after loadTimeoutMs instead of holding the load lock forever', async () => {
  const client = fakeClient();
  client.llm.port.createChannel = () => ({ onError: { subscribeOnce() {} } }); // never answers
  const daemon = createDaemon({ port: 1234, fetchImpl: async () => jsonResponse(200, {}), connect: async () => client, loadTimeoutMs: 20 });
  await assert.rejects(daemon.load({ modelKey: 'k', identifier: 'k', kvConfig: { fields: [] } }), /did not finish within/);
});

test('an application error (unknown identifier, OOM) keeps the client — a concurrent load channel must survive it', async () => {
  let opened = 0;
  const client = fakeClient();
  client.llm.port.callRpc = async () => {
    throw new Error('No model found that fits the query');
  };
  const daemon = createDaemon({
    port: 1234,
    fetchImpl: async () => jsonResponse(200, {}),
    connect: async () => {
      opened += 1;
      return client;
    },
  });
  await assert.rejects(daemon.unload({ type: 'llm', identifier: 'x' }), /No model found/);
  await assert.rejects(daemon.unload({ type: 'llm', identifier: 'x' }), /No model found/);
  assert.equal(opened, 1);
  assert.equal(client.disposed, 0);
});
