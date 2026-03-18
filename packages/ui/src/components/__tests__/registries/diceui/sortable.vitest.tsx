import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  Sortable,
  SortableContent,
  SortableItem,
} from '@/components/registries/diceui/sortable'

describe('Sortable', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Sortable value={['a', 'b']} getItemValue={(i) => i}>
        <SortableContent>
          <SortableItem value="a" asHandle>
            a
          </SortableItem>
          <SortableItem value="b" asHandle>
            b
          </SortableItem>
        </SortableContent>
      </Sortable>,
    )
    expect(container.firstChild).toBeTruthy()
  })
})
