import { redirect } from 'next/navigation';

/**
 * TASK-532 (M-03 / OD-6) — `/prompt-studio` folded into the Governance tab of
 * the prompt-template surface.
 *
 * The two routes edited the SAME backend (`admin/prompt-templates`); prompt
 * studio added only the approve write on top of a duplicate list. Kept for ONE
 * release so bookmarks and deep links keep working. Delete this folder in the
 * release after the one that ships the fold.
 *
 * TASK-634 R6 re-pointed the target from `/agents?tab=governance` to
 * `/prompt-templates?tab=governance` — the governance tab moved with the rest
 * of the `PromptTemplate` surface when it got its own route.
 *
 * Behaviour-neutral: `/prompt-studio` already required a working tenant, and
 * the target gates identically. Approve authority is server-side either way.
 */
export default function PromptStudioRedirectPage(): never {
  redirect('/prompt-templates?tab=governance');
}
