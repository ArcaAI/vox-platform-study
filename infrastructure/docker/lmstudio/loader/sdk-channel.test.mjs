// =============================================================================
// sdk-channel.mjs — the `loadModel` channel + `getLoadConfig` read-back,
// shared by the boot loader (load.mjs) and the residency agent (../agent/).
// =============================================================================
// No daemon: the SDK `port` is a fake that records what it was asked and
// replays the channel messages the daemon would send.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadOverChannel, readAppliedFields } from './sdk-channel.mjs';

/** A fake `client.llm.port`: createChannel replays `script` messages, or errors. */
const fakePort = ({ script = [], error } = {}) => {
  const calls = { channels: [], rpcs: [] };
  return {
    calls,
    createChannel(name, params, onMessage) {
      calls.channels.push({ name, params });
      const subscribers = [];
      queueMicrotask(() => {
        if (error) {
          for (const fn of subscribers) fn(error);
          return;
        }
        for (const message of script) onMessage(message);
      });
      return { onError: { subscribeOnce: (fn) => subscribers.push(fn) } };
    },
    async callRpc(name, params) {
      calls.rpcs.push({ name, params });
      return { fields: [{ key: 'llm.load.contextLength', value: 16384 }] };
    },
  };
};

const REQUEST = {
  modelKey: 'granite-guardian@q4_k_m',
  identifier: 'granite-guardian',
  ttlMs: undefined,
  kvConfig: { fields: [{ key: 'llm.load.contextLength', value: 16384 }] },
};

const INFO = { modelKey: 'granite-guardian@q4_k_m', identifier: 'granite-guardian', instanceReference: 'ref-1' };

test('loadOverChannel sends key, identifier, ttl and ONE apiOverride layer, and resolves with the info', async () => {
  const port = fakePort({ script: [{ type: 'resolved', info: INFO }, { type: 'success', info: INFO }] });
  const info = await loadOverChannel(port, REQUEST);
  assert.deepEqual(info, INFO);
  assert.equal(port.calls.channels.length, 1);
  const { name, params } = port.calls.channels[0];
  assert.equal(name, 'loadModel');
  assert.equal(params.modelKey, 'granite-guardian@q4_k_m');
  assert.equal(params.identifier, 'granite-guardian');
  assert.deepEqual(params.loadConfigStack, { layers: [{ layerName: 'apiOverride', config: REQUEST.kvConfig }] });
});

test('loadOverChannel reports resolution and progress to the caller hooks', async () => {
  const seen = [];
  const port = fakePort({
    script: [
      { type: 'resolved', info: INFO },
      { type: 'progress', progress: 0.5 },
      { type: 'success', info: INFO },
    ],
  });
  await loadOverChannel(port, REQUEST, {
    onResolved: (info) => seen.push(['resolved', info.modelKey]),
    onProgress: (p) => seen.push(['progress', p]),
  });
  assert.deepEqual(seen, [
    ['resolved', 'granite-guardian@q4_k_m'],
    ['progress', 0.5],
  ]);
});

test('loadOverChannel REFUSES an ambiguous resolution rather than serving a guess', async () => {
  const port = fakePort({
    script: [{ type: 'resolved', info: INFO, ambiguous: ['a@q4', 'a@q8'] }, { type: 'success', info: INFO }],
  });
  await assert.rejects(loadOverChannel(port, REQUEST), /AMBIGUOUS.*a@q4, a@q8/);
});

test('loadOverChannel rejects with the daemon error', async () => {
  const port = fakePort({ error: new Error('Failed to load model: out of memory') });
  await assert.rejects(loadOverChannel(port, REQUEST), /out of memory/);
});

test('readAppliedFields asks getLoadConfig for THAT instance and returns its fields', async () => {
  const port = fakePort();
  const fields = await readAppliedFields(port, 'ref-1');
  assert.deepEqual(fields, [{ key: 'llm.load.contextLength', value: 16384 }]);
  assert.deepEqual(port.calls.rpcs[0], {
    name: 'getLoadConfig',
    params: { specifier: { type: 'instanceReference', instanceReference: 'ref-1' } },
  });
});
