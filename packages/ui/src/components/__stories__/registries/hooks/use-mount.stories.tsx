import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { useMount } from '../../../../hooks/registries/use-mount'

function UseMountDemo() {
  const [message, setMessage] = useState('Waiting...')

  useMount(() => {
    setMessage('Component mounted!')
  })

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-lg font-semibold">{message}</p>
      <p className="text-muted-foreground text-sm">
        The message above was set during the mount callback.
      </p>
    </div>
  )
}

const meta = {
  title: 'Registries/Hooks/useMount',
  component: UseMountDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseMountDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
