import type { Meta, StoryObj } from '@storybook/react-vite'
import { useCounter } from '../../../../hooks/registries/use-counter'

function UseCounterDemo() {
  const [count, { inc, dec, set, reset }] = useCounter(0)

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-2xl font-bold">{count}</p>
      <div className="flex gap-2">
        <button className="rounded border px-3 py-1" onClick={dec}>-1</button>
        <button className="rounded border px-3 py-1" onClick={inc}>+1</button>
        <button className="rounded border px-3 py-1" onClick={() => set(100)}>Set 100</button>
        <button className="rounded border px-3 py-1" onClick={reset}>Reset</button>
      </div>
    </div>
  )
}

const meta = {
  title: 'Registries/Hooks/useCounter',
  component: UseCounterDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseCounterDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
