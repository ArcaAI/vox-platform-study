import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  GlassTooltipProvider,
  GlassTooltip,
  GlassTooltipTrigger,
} from '@/components/registries/einui/glass-tooltip'

describe('GlassTooltip', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <GlassTooltipProvider>
        <GlassTooltip>
          <GlassTooltipTrigger>Hover</GlassTooltipTrigger>
        </GlassTooltip>
      </GlassTooltipProvider>,
    )
    expect(container.firstChild).toBeTruthy()
  })
})
