import { useEffect, useState } from 'react'
import { useDebounceFn } from '@/hooks/registries/use-debounce-fn'
import type { DebounceOptions } from '@/hooks/registries/use-debounce-fn'

export function useDebounce<T>(
  value: T,
  debounceMs?: number,
  options?: DebounceOptions,
) {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  const { run } = useDebounceFn(
    () => {
      setDebouncedValue(value)
    },
    debounceMs,
    options,
  )

  useEffect(() => {
    return run()
  }, [value, run])

  return debouncedValue
}
