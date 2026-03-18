import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useMount } from '../../../../hooks/registries/use-mount'

describe('useMount', () => {
  it('calls the callback on mount', () => {
    const fn = vi.fn()
    renderHook(() => useMount(fn))
    expect(fn).toHaveBeenCalledOnce()
  })

  it('does not call the callback on rerender', () => {
    const fn = vi.fn()
    const { rerender } = renderHook(() => useMount(fn))
    rerender()
    expect(fn).toHaveBeenCalledOnce()
  })
})
