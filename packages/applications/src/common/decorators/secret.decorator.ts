/**
 * Phase 0 Item 4 (TASK-302 Stream A) — re-export shim.
 *
 * Source of truth lives in `@arcaai/domains/common/secret.decorator`
 * to keep the dependency arrow one-directional (applications -> domains,
 * never the reverse). This file exposes the decorator under the
 * applications namespace for ergonomic call sites.
 */
export { Secret, getSecretFields, SECRET_FIELDS_KEY } from '@arcaai/domains';
