// The Prometheus text exposition of the agent (hand-written, zero dependencies).
// Names, types and label sets are the python residency contract
// (packages/py-runtime-models/src/hope_runtime_models/metrics.py), so the
// `hope-model-residency` dashboard reads lm-studio with the SAME queries as stt/nlp.
import test from 'node:test';
import assert from 'node:assert/strict';

import { METRICS_CONTENT_TYPE, MODEL_LOAD_SECONDS_BUCKETS, SERVICE_LABEL, createMetrics, escapeLabel } from './metrics.mjs';

const REPORT = {
  service: 'lm-studio',
  models: [
    {
      model_ref: 'gemma-4-e2b-it-qat',
      device: 'cuda:1',
      device_bytes: { 'cuda:1': 3_350_000_000 },
    },
    {
      model_ref: 'granite-guardian-3.3-8b',
      device: 'multi',
      device_bytes: { 'cuda:0': 2_000_000_000, 'cuda:1': 2_900_000_000 },
    },
    { model_ref: 'qwen@q4', device: 'multi', device_bytes: {} },
  ],
};

const lines = (text) => text.split('\n').filter((line) => line !== '');

test('the service label mirrors stt/nlp: the residency service name, here lm-studio', () => {
  assert.equal(SERVICE_LABEL, 'lm-studio');
  assert.equal(METRICS_CONTENT_TYPE, 'text/plain; version=0.0.4; charset=utf-8');
  assert.deepEqual(MODEL_LOAD_SECONDS_BUCKETS, [0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 300]);
});

test('model_resident_bytes: one series per instance per card, from device_bytes', () => {
  const text = createMetrics().render(REPORT);
  assert.match(text, /^# HELP model_resident_bytes .+$/m);
  assert.match(text, /^# TYPE model_resident_bytes gauge$/m);
  const series = lines(text).filter((line) => line.startsWith('model_resident_bytes{'));
  assert.deepEqual(series, [
    'model_resident_bytes{service="lm-studio",model="gemma-4-e2b-it-qat",device="cuda:1"} 3350000000',
    'model_resident_bytes{service="lm-studio",model="granite-guardian-3.3-8b",device="cuda:0"} 2000000000',
    'model_resident_bytes{service="lm-studio",model="granite-guardian-3.3-8b",device="cuda:1"} 2900000000',
    // Unknown size: 0 = not measured, on the instance's own device (the python convention).
    'model_resident_bytes{service="lm-studio",model="qwen@q4",device="multi"} 0',
  ]);
});

test('model_resident: state="loaded" is 1 per instance per device; model_running_instances is 1 per instance', () => {
  const text = createMetrics().render(REPORT);
  assert.match(text, /^# TYPE model_resident gauge$/m);
  assert.ok(lines(text).includes('model_resident{service="lm-studio",model="gemma-4-e2b-it-qat",device="cuda:1",state="loaded"} 1'));
  assert.ok(lines(text).includes('model_resident{service="lm-studio",model="granite-guardian-3.3-8b",device="cuda:0",state="loaded"} 1'));
  assert.match(text, /^# TYPE model_running_instances gauge$/m);
  const running = lines(text).filter((line) => line.startsWith('model_running_instances{'));
  assert.deepEqual(running, [
    'model_running_instances{service="lm-studio",model="gemma-4-e2b-it-qat"} 1',
    'model_running_instances{service="lm-studio",model="granite-guardian-3.3-8b"} 1',
    'model_running_instances{service="lm-studio",model="qwen@q4"} 1',
  ]);
});

test('model_load_seconds is a cumulative histogram with the python buckets', () => {
  const metrics = createMetrics();
  metrics.observeLoad('gemma-4-e2b-it-qat', 7.5);
  metrics.observeLoad('gemma-4-e2b-it-qat', 0.2);
  const text = metrics.render(REPORT);
  assert.match(text, /^# TYPE model_load_seconds histogram$/m);
  const l = lines(text);
  const at = (le) => l.find((line) => line.startsWith(`model_load_seconds_bucket{service="lm-studio",model="gemma-4-e2b-it-qat",le="${le}"}`));
  assert.equal(at('0.5'), 'model_load_seconds_bucket{service="lm-studio",model="gemma-4-e2b-it-qat",le="0.5"} 1');
  assert.equal(at('5.0'), 'model_load_seconds_bucket{service="lm-studio",model="gemma-4-e2b-it-qat",le="5.0"} 1');
  assert.equal(at('10.0'), 'model_load_seconds_bucket{service="lm-studio",model="gemma-4-e2b-it-qat",le="10.0"} 2');
  assert.equal(at('+Inf'), 'model_load_seconds_bucket{service="lm-studio",model="gemma-4-e2b-it-qat",le="+Inf"} 2');
  assert.ok(l.includes('model_load_seconds_count{service="lm-studio",model="gemma-4-e2b-it-qat"} 2'));
  assert.ok(l.includes('model_load_seconds_sum{service="lm-studio",model="gemma-4-e2b-it-qat"} 7.7'));
});

test('model_evictions_total counts unloads by reason; HELP/TYPE always present', () => {
  const metrics = createMetrics();
  assert.match(metrics.render(null), /^# TYPE model_evictions_total counter$/m);
  metrics.countEviction('admin');
  metrics.countEviction('admin');
  metrics.countEviction('policy');
  const l = lines(metrics.render(null));
  assert.ok(l.includes('model_evictions_total{service="lm-studio",reason="admin"} 2'));
  assert.ok(l.includes('model_evictions_total{service="lm-studio",reason="policy"} 1'));
});

test('no report (daemon down): gauges carry no series, counters and histograms still render', () => {
  const metrics = createMetrics();
  metrics.observeLoad('m', 1);
  const text = metrics.render(null);
  assert.ok(!/^model_resident_bytes\{/m.test(text));
  assert.ok(!/^model_running_instances\{/m.test(text));
  assert.match(text, /^model_load_seconds_count\{service="lm-studio",model="m"\} 1$/m);
  assert.ok(text.endsWith('\n'));
});

test('label values are escaped per the exposition format', () => {
  assert.equal(escapeLabel('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  const text = createMetrics().render({ models: [{ model_ref: 'x"y', device: 'cuda:0', device_bytes: { 'cuda:0': 1 } }] });
  assert.ok(lines(text).includes('model_resident_bytes{service="lm-studio",model="x\\"y",device="cuda:0"} 1'));
});
