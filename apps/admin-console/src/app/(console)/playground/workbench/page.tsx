import { redirect } from 'next/navigation';

/**
 * TASK-893 — the Workbench is folded into the Workflow Studio. Testing and inspecting a
 * definition's nodes now happens in the Studio itself (the inspector's Run tab, built on
 * `@/shared/sandbox`) instead of a separate playground screen — see
 * `docs/implementation/TASK-893-Workflow-Studio-Redesign/README.md` §2.6/§3.6.
 *
 * Kept for ONE release so existing bookmarks and deep links keep working — including the former
 * `?definitionId=` deep link (`studio-toolbar.tsx`'s old "Test in Workbench" link): forwarded onto
 * `/workflow-studio/[definitionId]` (rule 13 §Routing — that path is the canonical deep link) so
 * an old bookmark still lands on the right definition, not just the studio's landing page. Delete
 * this folder in the release after the one that ships TASK-893.
 */
export default async function WorkbenchRedirectPage({ searchParams }: { searchParams: Promise<{ definitionId?: string }> }): Promise<never> {
  const { definitionId } = await searchParams;
  redirect(definitionId ? `/workflow-studio/${encodeURIComponent(definitionId)}` : '/workflow-studio');
}
