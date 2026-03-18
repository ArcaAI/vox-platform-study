import type { Meta, StoryObj } from '@storybook/react-vite'
import { useRef } from 'react'
import { useElementSize } from '../../../../hooks/registries/use-element-size'

function UseElementSizeDemo() {
  const ref = useRef<HTMLTextAreaElement>(null)
  const size = useElementSize(ref)

  return (
    <div className="flex flex-col items-center gap-4">
      <textarea
        ref={ref}
        className="resize rounded border p-2"
        defaultValue="Resize me!"
        rows={4}
        cols={30}
      />
      <p className="text-sm">
        Width: {size.width.toFixed(0)}px | Height: {size.height.toFixed(0)}px
      </p>
    </div>
  )
}

const meta = {
  title: 'Registries/Hooks/useElementSize',
  component: UseElementSizeDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseElementSizeDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
