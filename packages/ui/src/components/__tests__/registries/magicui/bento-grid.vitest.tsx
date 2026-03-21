import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { BentoGrid, BentoCard } from '../../../registries/magicui/bento-grid'

describe('BentoGrid', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <BentoGrid>
        <BentoCard
          name="Test Card"
          description="A test description"
          className="col-span-1"
          Icon={() => null}
          href="#"
          cta="Learn more"
          background={<div />}
        />
      </BentoGrid>
    )
    expect(container.firstChild).toBeTruthy()
  })
})
