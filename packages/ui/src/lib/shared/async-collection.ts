/**
 * Transport-agnostic async collection envelope (TASK-372 §3.1.4, D5).
 *
 * Works with TanStack Query infinite queries, SDK hooks, or plain fetch — the
 * library never imports a data layer; consumers pass this shape in.
 */
export interface AsyncCollection<T> {
  data: T[];
  isLoading: boolean;
  isFetchingNextPage?: boolean;
  error: Error | null;
  hasNextPage?: boolean;
  fetchNextPage?: () => void;
  refetch?: () => void;
  total?: number;
}
