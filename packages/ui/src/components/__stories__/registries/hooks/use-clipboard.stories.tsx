import type { Meta, StoryObj } from '@storybook/react-vite'
import { useClipboard } from '../../../../hooks/registries/use-clipboard'

function UseClipboardDemo() {
  const { text, copied, copy, isSupported } = useClipboard({ read: true, legacy: true })

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm">Clipboard supported: {String(isSupported)}</p>
      <button
        className="rounded border px-3 py-1"
        onClick={() => copy('Hello from useClipboard!')}
      >
        {copied ? 'Copied!' : 'Copy text'}
      </button>
      <p className="text-sm">Last copied: <code>{text || '(empty)'}</code></p>
    </div>
  )
}

const meta = {
  title: 'Registries/Hooks/useClipboard',
  component: UseClipboardDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseClipboardDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
