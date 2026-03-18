import { QueryCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

/**
 * Extract an HTTP status code from heterogeneous error shapes:
 *  - AdminApiError / SmrApiError: error.status
 *  - Fetch-style: error.response.status
 *  - AgenticError: error.context.status or error.code === 'AUTHENTICATION_ERROR'
 */
export function extractHttpStatus(error: unknown): number | undefined {
    const err = error as Record<string, any> | null | undefined;
    if (!err) return undefined;

    if (typeof err.status === 'number') return err.status;
    if (typeof err.response?.status === 'number') return err.response.status;
    if (typeof err.context?.status === 'number') return err.context.status;
    if (err.code === 'AUTHENTICATION_ERROR') return 401;

    return undefined;
}

export function createAppQueryClient(navigate: (opts: { to: string; search?: Record<string, string> }) => void) {
    return new QueryClient({
        defaultOptions: {
            queries: {
                retry: (failureCount) => {
                    if (import.meta.env.DEV) return false;
                    return failureCount < 3;
                },
                retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 15_000),
                refetchOnWindowFocus: import.meta.env.PROD,
                staleTime: 10 * 1000,
            },
            mutations: {
                onError: (error) => {
                    toast.error(error.message || 'Something went wrong');
                },
            },
        },
        queryCache: new QueryCache({
            onError: (error) => {
                const status = extractHttpStatus(error);
                if (status === 401) {
                    toast.error('Session expired');
                    navigate({ to: '/login' });
                } else if (status === 403) {
                    navigate({ to: '/403' });
                } else if (status === 500) {
                    toast.error('Internal server error');
                }
            },
        }),
    });
}
