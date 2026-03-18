import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('cobe', () => ({
  default: vi.fn(() => ({
    destroy: vi.fn(),
    toggle: vi.fn(),
  })),
}))

import { Globe } from '../../../registries/magicui/globe'

describe('Globe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue({
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      getImageData: vi.fn().mockReturnValue({ data: [] }),
      putImageData: vi.fn(),
      createImageData: vi.fn().mockReturnValue([]),
      setTransform: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      fillText: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      rotate: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      measureText: vi.fn().mockReturnValue({ width: 0 }),
      transform: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      canvas: { width: 800, height: 600 },
      enable: vi.fn(),
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext
  })

  afterEach(() => {
    vi.runAllTimers()
    vi.useRealTimers()
  })

  it('renders without crashing', () => {
    const { container } = render(
      <div style={{ width: 400, height: 400 }}>
        <Globe />
      </div>
    )
    vi.runAllTimers()
    expect(container.firstChild).toBeTruthy()
  })
})
