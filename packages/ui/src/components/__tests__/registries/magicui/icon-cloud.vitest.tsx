import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { IconCloud } from '../../../registries/magicui/icon-cloud'

describe('IconCloud', () => {
  beforeEach(() => {
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
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext
  })

  it('renders without crashing', () => {
    const { container } = render(
      <IconCloud images={["https://example.com/icon.png"]} />
    )
    expect(container.firstChild).toBeTruthy()
  })
})
