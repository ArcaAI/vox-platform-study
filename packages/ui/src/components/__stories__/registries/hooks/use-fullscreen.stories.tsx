import type { Meta, StoryObj } from '@storybook/react-vite'
import { useRef } from 'react'
import { useFullscreen } from '../../../../hooks/registries/use-fullscreen'

function UseFullscreenDemo() {
  const ref = useRef<HTMLDivElement>(null)
  const { isFullscreen, enter, exit, toggle } = useFullscreen(ref)

  return (
    <div className="flex flex-col items-center gap-4">
      <div ref={ref} className="rounded-lg border bg-gray-50 p-8 dark:bg-gray-900">
        <p className="font-semibold">Fullscreen: {String(isFullscreen)}</p>
        <div className="mt-2 flex gap-2">
          <button className="rounded border px-3 py-1" onClick={enter}>Enter</button>
          <button className="rounded border px-3 py-1" onClick={exit}>Exit</button>
          <button className="rounded border px-3 py-1" onClick={toggle}>Toggle</button>
        </div>
      </div>
    </div>
  )
}

const meta = {
  title: 'Registries/Hooks/useFullscreen',
  component: UseFullscreenDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseFullscreenDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
