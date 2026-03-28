import type { Meta, StoryObj } from '@storybook/react-vite';

import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from '../../../registries/ai-elements/tool';

const meta = {
  title: 'Registries/AiElements/Tool',
  component: Tool,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Tool>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Completed: Story = {
  args: {} as any,
  render: () => (
    <div className="w-[500px]">
      <Tool defaultOpen>
        <ToolHeader type="tool-invocation" state="output-available" title="Search Database" />
        <ToolContent>
          <ToolInput input={{ query: 'SELECT * FROM users LIMIT 10' }} />
          <ToolOutput output={{ rows: 10, status: 'success' }} errorText={undefined} />
        </ToolContent>
      </Tool>
    </div>
  ),
};

export const Running: Story = {
  args: {} as any,
  render: () => (
    <div className="w-[500px]">
      <Tool>
        <ToolHeader type="tool-invocation" state="input-available" title="Fetch API" />
      </Tool>
    </div>
  ),
};

export const WithError: Story = {
  args: {} as any,
  render: () => (
    <div className="w-[500px]">
      <Tool defaultOpen>
        <ToolHeader type="tool-invocation" state="output-error" title="Run Query" />
        <ToolContent>
          <ToolInput input={{ sql: 'INVALID QUERY' }} />
          <ToolOutput output={undefined} errorText="Syntax error near 'INVALID'" />
        </ToolContent>
      </Tool>
    </div>
  ),
};
