import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Dock, DockIcon } from '../../../registries/magicui/dock'

describe('Dock', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Dock>
        <DockIcon>
          <div>Icon</div>
        </DockIcon>
      </Dock>
    )
    expect(container.firstChild).toBeTruthy()
  })
})
