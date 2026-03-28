import type { Meta, StoryObj } from '@storybook/react-vite';
import { useNetwork } from '../../../../hooks/registries/use-network';

function UseNetworkDemo() {
  const network = useNetwork();

  return (
    <div className="flex flex-col items-center gap-4">
      <div
        className={`rounded-full px-4 py-2 text-sm font-semibold ${
          network.online
            ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
            : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
        }`}
      >
        {network.online ? 'Online' : 'Offline'}
      </div>
      <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
        <span className="text-muted-foreground">Type:</span>
        <span className="font-mono">{network.type ?? 'N/A'}</span>
        <span className="text-muted-foreground">Effective Type:</span>
        <span className="font-mono">{network.effectiveType ?? 'N/A'}</span>
        <span className="text-muted-foreground">Downlink:</span>
        <span className="font-mono">{network.downlink ?? 'N/A'} Mbps</span>
        <span className="text-muted-foreground">RTT:</span>
        <span className="font-mono">{network.rtt ?? 'N/A'} ms</span>
        <span className="text-muted-foreground">Save Data:</span>
        <span className="font-mono">{String(network.saveData ?? 'N/A')}</span>
      </div>
    </div>
  );
}

const meta = {
  title: 'Registries/Hooks/useNetwork',
  component: UseNetworkDemo,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof UseNetworkDemo>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
