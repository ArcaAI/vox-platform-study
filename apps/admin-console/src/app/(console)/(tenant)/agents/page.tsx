import { redirect } from 'next/navigation';

/**
 * `/agents` — the Agent Catalog — RETIRED with `DepartmentAgent` itself
 * A prompt template's binding to a workflow now lives on the NODE
 * that references it, so the screen's whole subject is gone; what a tenant
 * admin came here to do is split between two surfaces that already exist:
 *
 *  - the prompt templates themselves → `/prompt-templates` (which this file
 *    redirects to, because it is the closer match for why anyone bookmarked
 *    this route);
 *  - which prompt a workflow node uses → the node inspector in Workflow Studio.
 *
 * Kept for ONE release so bookmarks and deep links keep working — the
 * `/prompt-studio` precedent. **Delete this folder in the release after the one
 * that ships the retirement.**
 *
 * Behaviour-neutral: `/agents` already required a working tenant, and the
 * target gates identically.
 */
export default function AgentsRetiredRedirectPage(): never {
  redirect('/prompt-templates');
}
