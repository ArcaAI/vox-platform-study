import { redirect } from 'next/navigation';

/**
 * `/ai-operations/reconciliation` → `/ai-operations/consumption`.
 *
 * Provider Reconciliation (the vendor-billing comparison) was REMOVED outright
 * by TASK-862 (owner directive 2026-09-04): the `ProviderReconciliationRun`
 * table, the reconciler registry, `admin/usage/reconciliation` and the
 * `features/reconciliation` screen are all gone. The nearest live surface is
 * the consumption & cost dashboard, so bookmarks land there rather than 404.
 *
 * Per `13-nextjs-apps.md` this stub stands for ONE release.
 * DELETE THIS FILE in R3 (the release after the one that ships TASK-862).
 */
export default function ReconciliationRedirectPage() {
  redirect('/ai-operations/consumption');
}
