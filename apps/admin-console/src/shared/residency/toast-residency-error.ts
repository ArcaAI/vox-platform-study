import { toast } from 'sonner';
import { residencyErrorToast } from './api';

/** Shows `residencyErrorToast(error, what, extra)` as an error toast (title + code in the description). */
export function toastResidencyError(error: unknown, what: string, extra?: string): void {
  const { title, description } = residencyErrorToast(error, what, extra);
  if (description) toast.error(title, { description });
  else toast.error(title);
}
