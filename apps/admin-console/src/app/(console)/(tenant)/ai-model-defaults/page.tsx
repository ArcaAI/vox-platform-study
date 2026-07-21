import { permanentRedirect } from 'next/navigation';

/**
 * The screen formerly here was renamed `/ai-configuration` once it stopped
 * being about "model defaults" (every model picker had already been
 * write-locked to read-only). This redirect keeps bookmarks and deep links
 * alive for one release, then it is deleted.
 */
export default function AiModelDefaultsRedirectPage() {
  permanentRedirect('/ai-configuration');
}
