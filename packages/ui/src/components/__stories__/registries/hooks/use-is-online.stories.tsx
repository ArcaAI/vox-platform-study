import type { Meta, StoryObj } from '@storybook/react-vite';
import { useIsOnline } from '../../../../hooks/registries/use-is-online';

function UseIsOnlineDemo() {
  const isOnline = useIsOnline();

  return (
    <div className="flex flex-col items-center gap-4">
      <div
        className={`rounded-full px-4 py-2 text-sm font-semibold ${
          isOnline ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
        }`}
      >
        {isOnline ? 'Online' : 'Offline'}
      </div>
      <p className="text-muted-foreground text-sm">Toggle your network connection to see the status change.</p>
    </div>
  );
}

const meta = {
  title: 'Registries/Hooks/useIsOnline',
  component: UseIsOnlineDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseIsOnlineDemo>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
