import { useEffect } from 'react';
import { useLatest } from '@/hooks/registries/use-latest';

export function useUnmount(fn: () => void) {
  const fnRef = useLatest(fn);

  useEffect(
    () => () => {
      fnRef.current();
    },
    [],
  );
}
