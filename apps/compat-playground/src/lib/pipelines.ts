/**
 * Pipeline catalog fetch (TASK-597 Lane E, G1).
 *
 * The Connection tab lets a v1-migrating developer pick a REAL tenant
 * pipeline instead of hand-typing a `pipelineId`. We hit the public pipeline
 * listing route directly with the same `x-api-key` the `<ArcaCompatProvider>`
 * is configured with — identical auth parity to `lib/departments.ts`
 * (TASK-560/592 D2).
 *
 * The global prefix is `api/v1`, so the URL is
 * `{apiEndpoint}/api/v1/audio/pipelines`. The controller
 * (`apps/api/.../audio-pipeline-public.controller.ts#fetchAll`) returns a
 * bare `PipelineResponse[]`, but we map DEFENSIVELY — accepting an array or
 * any of the common paginated envelopes (`data`/`items`/`results`) — so a
 * future change to a wrapped response shape does not silently break the
 * picker. Mirrors `lib/departments.ts` deliberately; keep the two in sync.
 */

/** One selectable pipeline. `value` is what we submit as `pipelineId`. */
export interface PipelineOption {
  id: string;
  /** Submit value — the pipeline id. */
  value: string;
  /** Human label shown in the select (name, annotated with the slug). */
  label: string;
  /** Whether this is the tenant's default pipeline. */
  isDefault: boolean;
}

/** A single row as returned by `GET /api/v1/audio/pipelines` (subset we read). */
interface RawPipeline {
  id?: unknown;
  name?: unknown;
  slug?: unknown;
  isDefault?: unknown;
}

/** Pull the row array out of either a bare array or a paginated envelope. */
function extractRows(body: unknown): RawPipeline[] {
  if (Array.isArray(body)) return body as RawPipeline[];
  if (body && typeof body === 'object') {
    for (const key of ['data', 'items', 'results'] as const) {
      const candidate = (body as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate as RawPipeline[];
    }
  }
  return [];
}

function toOption(row: RawPipeline): PipelineOption | null {
  const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : undefined;
  if (!id) return null;
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : undefined;
  const slug = typeof row.slug === 'string' && row.slug.trim() ? row.slug.trim() : undefined;
  const isDefault = row.isDefault === true;
  return {
    id,
    value: id,
    // Show the name (falling back to the slug, then the id); annotate the
    // slug so the developer sees exactly what they're submitting.
    label: name ? (slug ? `${name} (${slug})` : name) : (slug ?? id),
    isDefault,
  };
}

/**
 * Fetch the tenant's pipelines. Rejects on any non-OK status or network
 * error so the caller can fall back to a free-text pipeline-id input.
 * Trailing slashes on `apiEndpoint` are tolerated.
 */
export async function fetchPipelines(apiEndpoint: string, apiKey: string): Promise<PipelineOption[]> {
  const origin = apiEndpoint.trim().replace(/\/+$/, '');
  const res = await fetch(`${origin}/api/v1/audio/pipelines`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Pipelines fetch failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  return extractRows(body)
    .map(toOption)
    .filter((o): o is PipelineOption => o !== null);
}
