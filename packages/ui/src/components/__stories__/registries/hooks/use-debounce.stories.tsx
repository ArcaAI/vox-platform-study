import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { useDebounce } from '../../../../hooks/registries/use-debounce'

function UseDebounceDemo() {
  const [input, setInput] = useState('')
  const debouncedValue = useDebounce(input, 500)

  return (
    <div className="flex flex-col items-center gap-4">
      <input
        className="rounded border px-3 py-2"
        placeholder="Type something..."
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <div className="text-sm">
        <p>Input: <code>{input}</code></p>
        <p>Debounced (500ms): <code>{debouncedValue}</code></p>
      </div>
    </div>
  )
}

const meta = {
  title: 'Registries/Hooks/useDebounce',
  component: UseDebounceDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseDebounceDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
