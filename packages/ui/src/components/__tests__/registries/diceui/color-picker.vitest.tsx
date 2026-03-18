import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  ColorPicker,
  ColorPickerContent,
  ColorPickerArea,
} from '@/components/registries/diceui/color-picker'

describe('ColorPicker', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <ColorPicker defaultValue="#ff0000" inline>
        <ColorPickerContent>
          <ColorPickerArea />
        </ColorPickerContent>
      </ColorPicker>,
    )
    expect(container.firstChild).toBeTruthy()
  })
})
