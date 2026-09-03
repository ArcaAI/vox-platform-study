/**
 * Every name in the generated surface is DERIVED, by the rules below, from
 * facts in the two input artifacts. None is transcribed, and none is
 * configurable — a lookup table of hand-chosen names would be exactly the
 * thing the ticket's "derive, don't transcribe" rule exists to prevent
 *
 * The rules, in one place so a reader can predict any generated name:
 *
 * | Thing | Rule | Example |
 * |---|---|---|
 * | area key | the `svc:` scope minus its `svc:`/`admin:` prefixes and its trailing ACTION segment, remaining `:` → `-` | `svc:admin:tenant-tts-config:manage` → `tenant-tts-config` |
 * | resource property | camelCase of the area key | `tenantTtsConfig` |
 * | resource class | `Admin` + PascalCase area key + `Resource` | `AdminTenantTtsConfigResource` |
 * | module file | `<area key>.ts` | `tenant-tts-config.ts` |
 * | method | the controller's HANDLER name | `TenantController.fetchAll` → `fetchAll` |
 * | method (collision) | camelCase(controller-without-`Controller` + handler) for EVERY member of the collision | `AiProviderCatalogController.list` → `aiProviderCatalogList` |
 * | paginated iterator | method name + `Iterate` | `fetchAllIterate` |
 *
 * The one rule worth justifying is the AREA. It could have come from the URL
 * (`admin/tenants` → `tenants`), which reads slightly better in English. It
 * comes from the SCOPE instead because the scope is the thing an integrator
 * actually has to hold: `hope.admin.tenantTtsConfig` and
 * `svc:admin:tenant-tts-config:manage` are one substitution apart, so a 403
 * names the property you called and the property names the scope you are
 * missing. Three admin controllers sharing one scope therefore share one
 * resource, which is correct — they are one permission surface.
 */

/** `svc:admin:tenant-tts-config:manage` → `tenant-tts-config`; `svc:webhook:event:write` → `webhook-event`. */
export function areaKeyFromScope(scope: string): string {
  const segments = scope.split(':').filter(Boolean);
  if (segments[0] === 'svc') segments.shift();
  if (segments[0] === 'admin') segments.shift();
  // Drop the trailing ACTION segment (`read`/`write`/`manage`) — it is the
  // verb the scope grants, not part of the area's identity. A one-segment
  // scope keeps its only segment rather than becoming empty.
  if (segments.length > 1) segments.pop();
  return segments.join('-');
}

/** `tenant-tts-config` → `tenantTtsConfig`. Also used for `AiProviderCatalogController` + `list` → `aiProviderCatalogList`. */
export function toCamelCase(value: string): string {
  const parts = splitWords(value);
  if (parts.length === 0) return value;
  return parts.map((part, index) => (index === 0 ? lowerFirst(part) : upperFirst(part))).join('');
}

/** `tenant-tts-config` → `TenantTtsConfig`. */
export function toPascalCase(value: string): string {
  return upperFirst(toCamelCase(value));
}

/** `AiProviderCatalogController` → `ai-provider-catalog`. */
export function controllerSlug(controller: string): string {
  return splitWords(controller.replace(/Controller$/, ''))
    .map((w) => w.toLowerCase())
    .join('-');
}

/**
 * Split on `-`, `_`, `.`, whitespace, and camel/Pascal humps, keeping acronym
 * runs together (`AiProviderAPIKey` → `Ai`, `Provider`, `API`, `Key`) so a
 * round trip through {@link toPascalCase} is stable.
 */
function splitWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
}

function upperFirst(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

const RESERVED = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

/** A safe TS identifier for a path parameter or a generated local. */
export function toIdentifier(value: string): string {
  const camel = toCamelCase(value);
  const safe = /^[A-Za-z_$]/.test(camel) ? camel : `_${camel}`;
  return RESERVED.has(safe) ? `${safe}Param` : safe;
}

/** `true` when `name` may be written as a bare object key / property access. */
export function isSafePropertyName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}
