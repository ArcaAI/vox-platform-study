// =============================================================================
// Prometheus metrics of the LM Studio residency agent (hand-written text format)
// =============================================================================
// The residency CONTRACT of packages/py-runtime-models/.../metrics.py, so the
// `hope-model-residency` Grafana dashboard reads lm-studio with the SAME queries
// it uses for stt and nlp:
//
//   model_resident{service,model,device,state}  gauge    1 per loaded instance per card (state="loaded")
//   model_resident_bytes{service,model,device}  gauge    the report's device_bytes (measured | estimated; 0 = unknown)
//   model_load_seconds{service,model}           histogram one observation per load THIS agent performed
//   model_evictions_total{service,reason}       counter  unloads, reason admin | policy
//   model_running_instances{service,model}      gauge    1 per loaded instance
//
// `service` is the residency service name, as stt ("stt") and nlp ("nlp") label
// it — here "lm-studio", the name the report and the gateway already use.
//
// Gauges are rebuilt from the residency report at every scrape (the report's
// state IS the truth; nothing is cached here). Counters and the histogram live
// in this process and restart at zero with it, which Prometheus' rate() and
// increase() already handle. Zero dependencies: the format is small enough to
// write by hand (exposition format 0.0.4).
// =============================================================================

export const SERVICE_LABEL = 'lm-studio';
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
/** MODEL_LOAD_SECONDS_BUCKETS in metrics.py. */
export const MODEL_LOAD_SECONDS_BUCKETS = Object.freeze([0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 300]);

const HELP = {
  model_resident: '1 while a model is in this residency state on this device, else 0',
  model_resident_bytes: 'Measured device-memory footprint of a resident model (0 = not measured)',
  model_load_seconds: 'Wall-clock seconds of a successful model load',
  model_evictions_total: 'Model evictions by reason (ttl|lru|pressure|admin|policy)',
  model_running_instances: 'Loaded LM Studio instances, by service and model.',
};

export const escapeLabel = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

const labels = (pairs) => `{${pairs.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}`;

/** prometheus_client's floatToGoString: integral values keep a ".0". */
const le = (bound) => (Number.isInteger(bound) ? bound.toFixed(1) : String(bound));

const num = (value) => (Number.isFinite(value) ? String(Math.round(value * 1e9) / 1e9) : '0');

const header = (out, name, type) => out.push(`# HELP ${name} ${HELP[name]}`, `# TYPE ${name} ${type}`);

export function createMetrics({ service = SERVICE_LABEL } = {}) {
  /** model -> { buckets: number[], count, sum } */
  const loads = new Map();
  /** reason -> count */
  const evictions = new Map();

  function observeLoad(model, seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const entry = loads.get(model) ?? { buckets: MODEL_LOAD_SECONDS_BUCKETS.map(() => 0), count: 0, sum: 0 };
    MODEL_LOAD_SECONDS_BUCKETS.forEach((bound, i) => {
      if (seconds <= bound) entry.buckets[i] += 1;
    });
    entry.count += 1;
    entry.sum += seconds;
    loads.set(model, entry);
  }

  function countEviction(reason) {
    evictions.set(reason, (evictions.get(reason) ?? 0) + 1);
  }

  /** @param {{ models: Array<{model_ref, device, device_bytes}> } | null} report  null = daemon unreadable */
  function render(report) {
    const models = Array.isArray(report?.models) ? report.models : [];
    const perCard = models.map((model) => {
      const entries = Object.entries(model.device_bytes ?? {});
      return { model, cards: entries.length > 0 ? entries : [[model.device ?? 'multi', 0]] };
    });
    const out = [];

    header(out, 'model_resident', 'gauge');
    for (const { model, cards } of perCard) {
      for (const [device] of cards) {
        out.push(`model_resident${labels([['service', service], ['model', model.model_ref], ['device', device], ['state', 'loaded']])} 1`);
      }
    }

    header(out, 'model_resident_bytes', 'gauge');
    for (const { model, cards } of perCard) {
      for (const [device, bytes] of cards) {
        out.push(`model_resident_bytes${labels([['service', service], ['model', model.model_ref], ['device', device]])} ${num(bytes)}`);
      }
    }

    header(out, 'model_load_seconds', 'histogram');
    for (const [model, entry] of loads) {
      const base = [['service', service], ['model', model]];
      MODEL_LOAD_SECONDS_BUCKETS.forEach((bound, i) => {
        out.push(`model_load_seconds_bucket${labels([...base, ['le', le(bound)]])} ${entry.buckets[i]}`);
      });
      out.push(`model_load_seconds_bucket${labels([...base, ['le', '+Inf']])} ${entry.count}`);
      out.push(`model_load_seconds_count${labels(base)} ${entry.count}`);
      out.push(`model_load_seconds_sum${labels(base)} ${num(entry.sum)}`);
    }

    header(out, 'model_evictions_total', 'counter');
    for (const [reason, count] of evictions) {
      out.push(`model_evictions_total${labels([['service', service], ['reason', reason]])} ${count}`);
    }

    header(out, 'model_running_instances', 'gauge');
    for (const model of models) {
      out.push(`model_running_instances${labels([['service', service], ['model', model.model_ref]])} 1`);
    }

    return `${out.join('\n')}\n`;
  }

  return { observeLoad, countEviction, render };
}
