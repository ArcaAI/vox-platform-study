import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useIsOnline } from '../../../../hooks/registries/use-is-online'

describe('useIsOnline', () => {
  it('returns a boolean value', () => {
    const { result } = renderHook(() => useIsOnline())
    expect(typeof result.current).toBe('boolean')
  })

  it('returns true by default in test environment', () => {
    const { result } = renderHook(() => useIsOnline())
    expect(result.current).toBe(true)
  })
})
