/**
 * v1-compatible mid-session engine switch response.
 *
 * `active` echoes the now-live engine back in compat vocabulary:
 *   - `pipeline` — the SDK-configured session pipeline (normalized `primary`)
 *   - `default`  — the tenant default provider (normalized `fallback`)
 */
export interface SwitchSessionResponse {
  switched: true;
  active: 'pipeline' | 'default';
}
