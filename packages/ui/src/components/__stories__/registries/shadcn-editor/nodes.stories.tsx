import type { Meta, StoryObj } from '@storybook/react-vite'

import { nodes } from '../../../registries/shadcn-editor/nodes'

const NodesDisplay = () => (
  <div className="space-y-2 p-4">
    <h3 className="text-lg font-semibold">Registered Lexical Nodes</h3>
    <ul className="list-disc pl-6 space-y-1">
      {nodes.map((node, index) => {
        const name = typeof node === 'function' ? node.name : String(node)
        return <li key={index}>{name}</li>
      })}
    </ul>
    <p className="text-sm text-muted-foreground">
      Total: {nodes.length} node(s)
    </p>
  </div>
)

const meta = {
  title: 'Registries/ShadcnEditor/Nodes',
  component: NodesDisplay,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof NodesDisplay>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {},
}
