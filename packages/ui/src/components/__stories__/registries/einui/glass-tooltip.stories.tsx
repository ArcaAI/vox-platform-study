import type { Meta, StoryObj } from '@storybook/react-vite';
import { GlassTooltip, GlassTooltipContent, GlassTooltipProvider, GlassTooltipTrigger } from '@/components/registries/einui/glass-tooltip';

function GlassTooltipDemo() {
  return (
    <GlassTooltipProvider>
      <GlassTooltip>
        <GlassTooltipTrigger asChild>
          <button type="button" className="rounded-md border border-white/20 bg-white/10 px-4 py-2 text-white backdrop-blur-xl">
            Hover me
          </button>
        </GlassTooltipTrigger>
        <GlassTooltipContent>
          <p>Tooltip content</p>
        </GlassTooltipContent>
      </GlassTooltip>
    </GlassTooltipProvider>
  );
}

const meta = {
  title: 'Registries/EinUI/GlassTooltip',
  component: GlassTooltipDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof GlassTooltipDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <GlassTooltipDemo />,
};
