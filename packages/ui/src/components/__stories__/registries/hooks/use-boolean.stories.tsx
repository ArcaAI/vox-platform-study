import type { Meta, StoryObj } from '@storybook/react-vite'
import { useBoolean } from '../../../../hooks/registries/use-boolean'

function UseBooleanDemo() {
  const [value, { setTrue, setFalse, toggle }] = useBoolean(false)

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-lg font-semibold">
        Value: <span className={value ? 'text-green-500' : 'text-red-500'}>{String(value)}</span>
      </p>
      <div className="flex gap-2">
        <button className="rounded border px-3 py-1" onClick={setTrue}>Set True</button>
        <button className="rounded border px-3 py-1" onClick={setFalse}>Set False</button>
        <button className="rounded border px-3 py-1" onClick={toggle}>Toggle</button>
      </div>
    </div>
  )
}

const meta = {
  title: 'Registries/Hooks/useBoolean',
  component: UseBooleanDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseBooleanDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
