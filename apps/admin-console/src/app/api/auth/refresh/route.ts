import { refreshSession } from '@/server/refresh';
import { toSafeSession } from '@/server/safe-user';
import { getSession } from '@/server/session';

/** Explicit rotation: refresh via the gateway and reseal the cookie. */
export async function POST(): Promise<Response> {
    const session = await getSession();
    if (!session) {
        return Response.json({ message: 'Unauthorized' }, { status: 401 });
    }
    const refreshed = await refreshSession(session);
    if (!refreshed) {
        return Response.json({ message: 'Session expired' }, { status: 401 });
    }
    return Response.json(toSafeSession(refreshed));
}
