import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  TagsInput,
  TagsInputList,
  TagsInputInput,
} from '@/components/registries/diceui/tags-input'

describe('TagsInput', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <TagsInput>
        <TagsInputList>
          <TagsInputInput placeholder="Add..." />
        </TagsInputList>
      </TagsInput>,
    )
    expect(container.firstChild).toBeTruthy()
  })
})
