import type { Meta, StoryObj } from '@storybook/react-vite'

import { DataTable } from '../../../registries/tool-ui/data-table'

const meta = {
  title: 'Registries/ToolUI/DataTable',
  component: DataTable,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<any>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {} as any,
  render: () => (
    <DataTable
      id="1"
      columns={[
        { key: 'name' as const, label: 'Name' },
        { key: 'email' as const, label: 'Email' },
      ]}
      data={[
        { name: 'Alice', email: 'alice@example.com' },
        { name: 'Bob', email: 'bob@example.com' },
      ]}
    />
  ),
}
