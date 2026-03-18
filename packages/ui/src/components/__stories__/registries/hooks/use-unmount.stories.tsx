import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { useUnmount } from '../../../../hooks/registries/use-unmount'

function UnmountChild({ onUnmount }: { onUnmount: () => void }) {
  useUnmount(onUnmount)
  return <p className="rounded border p-4">I will log on unmount. Toggle me off!</p>
}

function UseUnmountDemo() {
  const [show, setShow] = useState(true)
  const [log, setLog] = useState<string[]>([])

  return (
    <div className="flex flex-col items-center gap-4">
      <button className="rounded border px-3 py-1" onClick={() => setShow((s) => !s)}>
        {show ? 'Unmount Child' : 'Mount Child'}
      </button>
      {show && (
        <UnmountChild
          onUnmount={() => setLog((prev) => [...prev, `Unmounted at ${new Date().toLocaleTimeString()}`])}
        />
      )}
      {log.length > 0 && (
        <div className="text-muted-foreground text-xs">
          {log.map((entry, i) => (
            <p key={i}>{entry}</p>
          ))}
        </div>
      )}
    </div>
  )
}

const meta = {
  title: 'Registries/Hooks/useUnmount',
  component: UseUnmountDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseUnmountDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
