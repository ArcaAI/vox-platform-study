import { toast } from 'sonner';

/** Uniform mutation-failure toast: surfaces the gateway message when present. */
export function toastRequestError(error: unknown) {
    toast.error(error instanceof Error && error.message ? error.message : 'Request failed');
}
