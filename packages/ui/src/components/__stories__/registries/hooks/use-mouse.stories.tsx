import type { Meta, StoryObj } from '@storybook/react-vite'
import { useMouse } from '../../../../hooks/registries/use-mouse'

function UseMouseDemo() {
  const mouse = useMouse()

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
        <span className="text-muted-foreground">x:</span>
        <span className="font-mono">{mouse.x}</span>
        <span className="text-muted-foreground">y:</span>
        <span className="font-mono">{mouse.y}</span>
        <span className="text-muted-foreground">source:</span>
        <span className="font-mono">{mouse.sourceType ?? 'none'}</span>
      </div>
      <p className="text-muted-foreground text-sm">Move your mouse to see coordinates update.</p>
    </div>
  )
}

const meta = {
  title: 'Registries/Hooks/useMouse',
  component: UseMouseDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseMouseDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
