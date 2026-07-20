import { redirect } from 'next/navigation';

/**
 * TASK-532 (M-03 / OD-6) — `/prompt-studio` folded into the `/agents`
 * Governance tab.
 *
 * The two routes edited the SAME backend (`admin/prompt-templates`); prompt
 * studio added only the approve write on top of a duplicate list. Kept for ONE
 * release so bookmarks and deep links keep working. Delete this folder in the
 * release after the one that ships the fold.
 *
 * Behaviour-neutral: `/prompt-studio` already required a working tenant, and
 * `/agents` gates identically. Approve authority is server-side either way.
 */
export default function PromptStudioRedirectPage(): never {
    redirect('/agents?tab=governance');
}
