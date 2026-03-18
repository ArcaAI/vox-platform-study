import type { Meta, StoryObj } from '@storybook/react-vite'

const meta = {
  title: 'Registries/DiceUI/DataTable',
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="rounded border p-4 text-muted-foreground text-sm">
      DataTable requires a TanStack table instance. Use with useReactTable() and
      column definitions.
    </div>
  ),
}
