/**
 * Fetch what a tenant PUBLISHES — its agents and its workflows — over the BUSINESS plane
 * (TASK-931).
 *
 * The other fetcher in this package reads the consultation context schema with a super-admin
 * JWT and `X-Tenant-Id`, which is a platform-operator credential. This one holds an **API key**
 * and nothing else, because that is what an integrator actually has, and because an API key
 * can never reach `/admin/*` — every admin controller carries `@ForbidApiKey()`. So this
 * module cannot accidentally type something the tenant has not published: the credential makes
 * the restriction structural rather than a rule someone has to remember.
 *
 * Four routes, all of them the same ones `@arcaai/vox-node`'s `hope.agents` / `hope.workflows`
 * call at runtime:
 *
 * ```
 * GET /api/v1/agents                     -> the published agent catalogue
 * GET /api/v1/agents/{slug}              -> that agent's inputSchema / outputSchema
 * GET /api/v1/workflows                  -> the published workflow catalogue
 * GET /api/v1/workflows/{slug}/schema    -> that definition's generated components
 * ```
 *
 * `GET /agents` already carries the schemas today, and the per-slug read is done anyway: the
 * list route's projection is a summary contract that may narrow, and a generator that silently
 * emitted `unknown` because a field stopped being listed would be worse than one extra request
 * per agent at build time.
 *
 * Fail LOUDLY, like the sibling fetcher: a non-2xx or a malformed body throws {@link
 * CodegenError} rather than emitting a file that claims the tenant published nothing.
 */

import { CodegenError } from './errors';
import type { PublishedAgent, PublishedCatalogue, PublishedWorkflow } from './types';

export interface FetchPublishedCatalogueOptions {
  /** Gateway origin, e.g. `http://localhost:8868`. May include a trailing `/api/v1` — normalized away. */
  baseUrl: string;
  /** Sent as `X-API-Key`. The ONLY credential this mode uses. */
  apiKey: string;
  /** Read the published agents. */
  agents: boolean;
  /** Read the published workflows. */
  workflows: boolean;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const API_PREFIX = '/api/v1';

function normalizeBaseUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return base.endsWith(API_PREFIX) ? base.slice(0, -API_PREFIX.length) : base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One authenticated GET, parsed as JSON. Throws {@link CodegenError} on anything but a 2xx JSON body. */
async function getJson(url: string, apiKey: string, doFetch: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await doFetch(url, { headers: { 'X-API-Key': apiKey, Accept: 'application/json' } });
  } catch (cause) {
    throw new CodegenError(`Failed to reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new CodegenError(`GET ${url} returned ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`);
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new CodegenError(`GET ${url} returned a body that could not be parsed as JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** The `{ data: [...] }` envelope both catalogue routes answer. An absent array is a malformed body, not "none published". */
function readCollection(raw: unknown, url: string): Record<string, unknown>[] {
  if (!isPlainObject(raw)) throw new CodegenError(`GET ${url} returned a non-object response body`);
  const data = raw.data;
  if (!Array.isArray(data)) throw new CodegenError(`GET ${url} returned no \`data\` array`);
  return data.filter(isPlainObject);
}

function readSlug(entry: Record<string, unknown>, url: string): string {
  const slug = entry.slug;
  if (typeof slug !== 'string' || slug.length === 0) throw new CodegenError(`GET ${url} returned an entry with no \`slug\``);
  return slug;
}

function schemaOrNull(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

/**
 * Pull one definition's input/output schema out of the schema route's `components`.
 *
 * The gateway keys them `Workflow_<slug>_Input` / `_Output`, but the slug can carry characters
 * that make the exact key awkward to reconstruct here — so the suffix is matched instead of the
 * whole key. That also keeps this working if the gateway ever changes its own prefix.
 */
function componentBySuffix(components: unknown, suffix: string): Record<string, unknown> | null {
  if (!isPlainObject(components)) return null;
  for (const [key, value] of Object.entries(components)) {
    if (key.endsWith(suffix) && isPlainObject(value)) return value;
  }
  return null;
}

async function fetchAgents(base: string, apiKey: string, doFetch: typeof fetch): Promise<PublishedAgent[]> {
  const listUrl = `${base}${API_PREFIX}/agents`;
  const entries = readCollection(await getJson(listUrl, apiKey, doFetch), listUrl);

  const agents: PublishedAgent[] = [];
  for (const entry of entries) {
    const slug = readSlug(entry, listUrl);
    const detailUrl = `${base}${API_PREFIX}/agents/${encodeURIComponent(slug)}`;
    const detail = await getJson(detailUrl, apiKey, doFetch);
    if (!isPlainObject(detail)) throw new CodegenError(`GET ${detailUrl} returned a non-object response body`);
    agents.push({
      slug,
      name: typeof detail.name === 'string' ? detail.name : slug,
      description: typeof detail.description === 'string' ? detail.description : null,
      task: typeof detail.task === 'string' ? detail.task : null,
      versionNumber: typeof detail.versionNumber === 'number' ? detail.versionNumber : null,
      inputSchema: schemaOrNull(detail.inputSchema),
      outputSchema: schemaOrNull(detail.outputSchema),
    });
  }
  return agents;
}

async function fetchWorkflows(base: string, apiKey: string, doFetch: typeof fetch): Promise<PublishedWorkflow[]> {
  const listUrl = `${base}${API_PREFIX}/workflows`;
  const entries = readCollection(await getJson(listUrl, apiKey, doFetch), listUrl);

  const workflows: PublishedWorkflow[] = [];
  for (const entry of entries) {
    const slug = readSlug(entry, listUrl);
    const schemaUrl = `${base}${API_PREFIX}/workflows/${encodeURIComponent(slug)}/schema`;
    const described = await getJson(schemaUrl, apiKey, doFetch);
    if (!isPlainObject(described)) throw new CodegenError(`GET ${schemaUrl} returned a non-object response body`);
    workflows.push({
      slug,
      name: typeof entry.name === 'string' ? entry.name : slug,
      description: typeof entry.description === 'string' ? entry.description : null,
      versionNumber: typeof described.versionNumber === 'number' ? described.versionNumber : null,
      triggerKinds: Array.isArray(described.triggerKinds) ? described.triggerKinds.filter((k): k is string => typeof k === 'string') : [],
      protocols: Array.isArray(described.protocols) ? described.protocols.filter((p): p is string => typeof p === 'string') : [],
      // `inputSchema` on the LIST entry is the same schema; `components` is the authoritative
      // projection, so prefer it and fall back only when the definition declares none.
      inputSchema: componentBySuffix(described.components, '_Input') ?? schemaOrNull(entry.inputSchema),
      outputSchema: componentBySuffix(described.components, '_Output') ?? schemaOrNull(entry.outputSchema),
    });
  }
  return workflows;
}

/** Read the published catalogue for the tenant the API key belongs to. Throws {@link CodegenError} on any failure. */
export async function fetchPublishedCatalogue(options: FetchPublishedCatalogueOptions): Promise<PublishedCatalogue> {
  const base = normalizeBaseUrl(options.baseUrl);
  const doFetch = options.fetchImpl ?? fetch;
  return {
    agents: options.agents ? await fetchAgents(base, options.apiKey, doFetch) : [],
    workflows: options.workflows ? await fetchWorkflows(base, options.apiKey, doFetch) : [],
  };
}
