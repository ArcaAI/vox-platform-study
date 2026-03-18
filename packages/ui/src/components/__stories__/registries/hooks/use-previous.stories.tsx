import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import usePrevious from '../../../../hooks/registries/use-previous'

function UsePreviousDemo() {
  const [count, setCount] = useState(0)
  const previousCount = usePrevious(count)

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="text-sm">
        <p>Current: <strong>{count}</strong></p>
        <p>Previous: <strong>{previousCount ?? 'undefined'}</strong></p>
      </div>
      <button className="rounded border px-3 py-1" onClick={() => setCount((c) => c + 1)}>
        Increment
      </button>
    </div>
  )
}

const meta = {
  title: 'Registries/Hooks/usePrevious',
  component: UsePreviousDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UsePreviousDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
