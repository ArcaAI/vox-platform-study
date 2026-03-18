import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  TooltipPositioner,
} from '../../../registries/basecn/tooltip'

describe('Tooltip', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Hover</TooltipTrigger>
          <TooltipPositioner>
            <TooltipContent>Tooltip text</TooltipContent>
          </TooltipPositioner>
        </Tooltip>
      </TooltipProvider>
    )
    expect(container.firstChild).toBeTruthy()
  })
})
