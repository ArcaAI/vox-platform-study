import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useDocumentVisibility } from '../../../../hooks/registries/use-document-visibility'

describe('useDocumentVisibility', () => {
  it('returns a visibility state string', () => {
    const { result } = renderHook(() => useDocumentVisibility())
    expect(['visible', 'hidden']).toContain(result.current)
  })

  it('returns "visible" by default in test environment', () => {
    const { result } = renderHook(() => useDocumentVisibility())
    expect(result.current).toBe('visible')
  })
})
