import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef } from 'react';
import { useInViewport } from '../../../../hooks/registries/use-in-viewport';

function UseInViewportDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const [inViewport] = useInViewport(ref);

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm">Scroll down to see the tracked element</p>
      <div className="h-48 w-64 overflow-auto rounded border p-2">
        <div className="h-96">
          <div ref={ref} className="mt-64 rounded bg-blue-100 p-4 dark:bg-blue-900">
            Tracked element
          </div>
        </div>
      </div>
      <p className="text-sm">In viewport: {String(inViewport)}</p>
    </div>
  );
}

const meta = {
  title: 'Registries/Hooks/useInViewport',
  component: UseInViewportDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseInViewportDemo>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
