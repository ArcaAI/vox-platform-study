import type { Meta, StoryObj } from '@storybook/react-vite'
import useToggle from '../../../../hooks/registries/use-toggle'

function UseToggleDemo() {
  const [value, { toggle, setLeft, setRight }] = useToggle('Hello', 'World')

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-lg font-semibold">Value: {String(value)}</p>
      <div className="flex gap-2">
        <button className="rounded border px-3 py-1" onClick={toggle}>Toggle</button>
        <button className="rounded border px-3 py-1" onClick={setLeft}>Set Left (Hello)</button>
        <button className="rounded border px-3 py-1" onClick={setRight}>Set Right (World)</button>
      </div>
    </div>
  )
}

const meta = {
  title: 'Registries/Hooks/useToggle',
  component: UseToggleDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseToggleDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
