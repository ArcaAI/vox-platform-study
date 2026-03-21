import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import {
  ResponsiveDialog,
  ResponsiveDialogTrigger,
} from '@/components/registries/diceui/responsive-dialog'

describe('ResponsiveDialog', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <ResponsiveDialog>
        <ResponsiveDialogTrigger>Open</ResponsiveDialogTrigger>
      </ResponsiveDialog>,
    )
    expect(container.firstChild).toBeTruthy()
  })
})
