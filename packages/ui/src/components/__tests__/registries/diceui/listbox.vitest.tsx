import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Listbox, ListboxItem } from '@/components/registries/diceui/listbox'

describe('Listbox', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <Listbox>
        <ListboxItem value="item1">Item 1</ListboxItem>
      </Listbox>,
    )
    expect(container.firstChild).toBeTruthy()
  })
})
