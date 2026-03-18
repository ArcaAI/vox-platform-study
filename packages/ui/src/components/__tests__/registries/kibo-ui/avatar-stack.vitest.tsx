import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { AvatarStack } from '../../../registries/kibo-ui/avatar-stack'

describe('AvatarStack', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <AvatarStack>
        <div>Avatar 1</div>
        <div>Avatar 2</div>
      </AvatarStack>
    )
    expect(container.firstChild).toBeTruthy()
  })
})
