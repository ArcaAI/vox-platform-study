import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  Stepper,
  StepperList,
  StepperItem,
  StepperTrigger,
  StepperIndicator,
} from '@/components/registries/diceui/stepper'

describe('Stepper', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Stepper defaultValue="1">
        <StepperList>
          <StepperItem value="1">
            <StepperTrigger>
              <StepperIndicator />
            </StepperTrigger>
          </StepperItem>
        </StepperList>
      </Stepper>,
    )
    expect(container.firstChild).toBeTruthy()
  })
})
