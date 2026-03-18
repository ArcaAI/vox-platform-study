import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { useInterval } from '../../../../hooks/registries/use-interval'

function UseIntervalDemo() {
  const [count, setCount] = useState(0)
  const [delay, setDelay] = useState<number | undefined>(1000)

  const clear = useInterval(() => {
    setCount((c) => c + 1)
  }, delay)

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-2xl font-bold">{count}</p>
      <div className="flex gap-2">
        <button className="rounded border px-3 py-1" onClick={() => setDelay(1000)}>
          Start (1s)
        </button>
        <button className="rounded border px-3 py-1" onClick={() => setDelay(undefined)}>
          Stop
        </button>
        <button className="rounded border px-3 py-1" onClick={clear}>
          Clear
        </button>
      </div>
    </div>
  )
}

const meta = {
  title: 'Registries/Hooks/useInterval',
  component: UseIntervalDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseIntervalDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
