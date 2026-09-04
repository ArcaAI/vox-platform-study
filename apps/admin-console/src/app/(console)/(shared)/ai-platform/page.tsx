import { redirect } from 'next/navigation';

/**
 * `/ai-platform` → `/ai-providers`.
 *
 * TASK-862 dissolved the five-tab AI Platform hub: its Providers tab became
 * the one `/ai-providers` screen (this redirect's target), the model catalogue
 * and model store live on `/ai-models` (TASK-860), engine status on
 * `/ai-services/*`, and task routing moves to the registry's "platform default
 * for task" election plus the Agent (TASK-863). Bookmarks and deep links land on
 * the provider screen rather than 404.
 *
 * The stub sits in `(shared)`, like the screen it replaced, so a tenant admin
 * following an old link is forwarded rather than `notFound()`-ed by the
 * `(global)` layout.
 *
 * Per `13-nextjs-apps.md` this stub stands for ONE release.
 * DELETE THIS FILE in R3 (the release after the one that ships TASK-862).
 */
export default function AiPlatformRedirectPage() {
  redirect('/ai-providers');
}
