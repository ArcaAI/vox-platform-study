import { redirect } from 'next/navigation';
import { getSession, isElevated } from '@/server/session';

/**
 * `/` is not a screen: it forwards to the first screen this session can open.
 *
 * `/dashboard` is a tier 10-19 route and its group layout `notFound()`s every
 * non-elevated session, so redirecting there unconditionally made "Page not
 * found" the first thing a TENANT admin saw after logging in. Tenant sessions
 * land on the first tier 30-49 screen instead (`manage:Department` is seeded on
 * the tenant-admin role). An absent session takes the same branch — `proxy.ts`
 * owns the redirect to login.
 */
export default async function RootPage(): Promise<never> {
  const session = await getSession();
  redirect(isElevated(session?.user) ? '/dashboard' : '/departments');
}
