/**
 * v1-compatible mid-session engine switch response (TASK-586 C3).
 *
 * `active` echoes the now-live engine back in compat vocabulary:
 *   - `pipeline` — the SDK-configured session pipeline (normalized `primary`)
 *   - `default`  — the tenant default provider (normalized `fallback`)
 */
export interface SwitchSessionResponse {
  switched: true;
  active: 'pipeline' | 'default';
}
