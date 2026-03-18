import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { useEventListener } from '../../../../hooks/registries/use-event-listener'

function UseEventListenerDemo() {
  const [key, setKey] = useState<string>('(press a key)')

  useEventListener('keydown', (e) => {
    setKey(e.key)
  })

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-lg font-semibold">Last key pressed: <code>{key}</code></p>
      <p className="text-muted-foreground text-sm">Press any key on your keyboard.</p>
    </div>
  )
}

const meta = {
  title: 'Registries/Hooks/useEventListener',
  component: UseEventListenerDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseEventListenerDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
