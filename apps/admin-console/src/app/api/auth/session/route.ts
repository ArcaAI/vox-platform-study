import { toSafeSession } from '@/server/safe-user';
import { getSession } from '@/server/session';

/** Client hydration endpoint: the safe session projection, never tokens. */
export async function GET(): Promise<Response> {
    const session = await getSession();
    if (!session) {
        return Response.json({ message: 'Unauthorized' }, { status: 401 });
    }
    return Response.json(toSafeSession(session));
}
