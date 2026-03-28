import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef } from 'react';
import { useHover } from '../../../../hooks/registries/use-hover';

function UseHoverDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const isHovered = useHover(ref);

  return (
    <div className="flex flex-col items-center gap-4">
      <div
        ref={ref}
        className={`rounded-lg border-2 p-8 transition-colors ${isHovered ? 'border-green-400 bg-green-50 dark:bg-green-950' : 'border-gray-300'}`}
      >
        Hover over me
      </div>
      <p className="text-sm">Hovered: {String(isHovered)}</p>
    </div>
  );
}

const meta = {
  title: 'Registries/Hooks/useHover',
  component: UseHoverDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseHoverDemo>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
