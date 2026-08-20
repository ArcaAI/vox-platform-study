import { isSpecPlane, resolveDocsAccess, specForPlane } from '@/server/api-docs';

/**
 * TASK-783 — serves one developer-portal OpenAPI projection to an entitled caller.
 *
 *   GET /api/docs/spec/business   requires read:ApiDocumentation
 *   GET /api/docs/spec/admin      requires manage:ApiDocumentation
 *
 * Deliberately NOT a static asset and NOT part of the client bundle. The
 * business projection is public-ish in spirit but not in fact: it describes a
 * private healthcare API, and who may read it is a product decision the
 * gateway's RBAC owns. Serving it from a route handler is what makes that
 * decision enforceable per request.
 *
 * The 403 is uniform across "no ability at all" and "ability, but not for this
 * plane", so an under-privileged caller cannot probe which projections exist.
 */
type RouteContext = { params: Promise<{ plane: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { plane } = await context.params;

  if (!isSpecPlane(plane)) {
    return Response.json({ message: 'Not found' }, { status: 404 });
  }

  const access = await resolveDocsAccess(request);
  const spec = specForPlane(plane, access);

  if (!spec) {
    return Response.json({ message: 'Forbidden' }, { status: 403 });
  }

  return Response.json(spec, {
    // Entitlement is per-request and per-caller, so nothing about this response
    // may be cached by a shared cache or replayed to a different session.
    headers: { 'cache-control': 'private, no-store' },
  });
}
