import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import useToggle from '../../../../hooks/registries/use-toggle'

describe('useToggle', () => {
  it('defaults to false when no arguments', () => {
    const { result } = renderHook(() => useToggle())
    expect(result.current[0]).toBe(false)
  })

  it('initializes with provided default value', () => {
    const { result } = renderHook(() => useToggle('hello'))
    expect(result.current[0]).toBe('hello')
  })

  it('toggles between default and reverse value', () => {
    const { result } = renderHook(() => useToggle('A', 'B'))
    expect(result.current[0]).toBe('A')
    act(() => result.current[1].toggle())
    expect(result.current[0]).toBe('B')
    act(() => result.current[1].toggle())
    expect(result.current[0]).toBe('A')
  })

  it('setLeft returns to default value', () => {
    const { result } = renderHook(() => useToggle('A', 'B'))
    act(() => result.current[1].toggle())
    expect(result.current[0]).toBe('B')
    act(() => result.current[1].setLeft())
    expect(result.current[0]).toBe('A')
  })

  it('setRight sets to reverse value', () => {
    const { result } = renderHook(() => useToggle('A', 'B'))
    act(() => result.current[1].setRight())
    expect(result.current[0]).toBe('B')
  })

  it('set allows explicit value', () => {
    const { result } = renderHook(() => useToggle('A', 'B'))
    act(() => result.current[1].set('B'))
    expect(result.current[0]).toBe('B')
  })
})
