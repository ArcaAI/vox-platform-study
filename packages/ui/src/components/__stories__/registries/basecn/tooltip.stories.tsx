import type { Meta, StoryObj } from '@storybook/react-vite';

import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../../../registries/basecn/tooltip';
import { Button } from '../../../registries/basecn/button';

const meta = {
  title: 'Registries/Basecn/Tooltip',
  component: Tooltip,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {} as any,
  render: () => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<Button variant="outline">Hover me</Button>} />
        <TooltipContent>
          <p>This is a tooltip</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
};
