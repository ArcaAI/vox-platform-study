import type { Meta, StoryObj } from '@storybook/react-vite'
import { useDocumentVisibility } from '../../../../hooks/registries/use-document-visibility'

function UseDocumentVisibilityDemo() {
  const visibility = useDocumentVisibility()

  return (
    <div className="flex flex-col items-center gap-4">
      <div className={`rounded-full px-4 py-2 text-sm font-semibold ${
        visibility === 'visible'
          ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
          : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
      }`}>
        {visibility}
      </div>
      <p className="text-muted-foreground text-sm">
        Switch to another tab to see the state change to &quot;hidden&quot;.
      </p>
    </div>
  )
}

const meta = {
  title: 'Registries/Hooks/useDocumentVisibility',
  component: UseDocumentVisibilityDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseDocumentVisibilityDemo>

export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {}
