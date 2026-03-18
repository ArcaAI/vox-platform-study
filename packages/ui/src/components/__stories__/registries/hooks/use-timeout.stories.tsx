import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { useTimeout } from '../../../../hooks/registries/use-timeout'

function UseTimeoutDemo() {
  const [message, setMessage] = useState('Waiting for timeout...')

  useTimeout(() => {
    setMessage('Timeout fired after 2 seconds!')
  }, 2000)

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-lg font-semibold">{message}</p>
    </div>
  )
}

const meta = {
  title: 'Registries/Hooks/useTimeout',
  component: UseTimeoutDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseTimeoutDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
