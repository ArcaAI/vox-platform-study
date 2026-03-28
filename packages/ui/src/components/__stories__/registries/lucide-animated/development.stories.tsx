import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  FileTextIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  TerminalIcon,
  CpuIcon,
  RocketIcon,
  EarthIcon,
  WifiIcon,
  BluetoothIcon,
  ActivityIcon,
} from '@/components/registries/lucide-animated';

const icons = [
  { name: 'file-text', Icon: FileTextIcon },
  { name: 'folder-open', Icon: FolderOpenIcon },
  { name: 'git-branch', Icon: GitBranchIcon },
  { name: 'git-commit-horizontal', Icon: GitCommitHorizontalIcon },
  { name: 'terminal', Icon: TerminalIcon },
  { name: 'cpu', Icon: CpuIcon },
  { name: 'rocket', Icon: RocketIcon },
  { name: 'earth', Icon: EarthIcon },
  { name: 'wifi', Icon: WifiIcon },
  { name: 'bluetooth', Icon: BluetoothIcon },
  { name: 'activity', Icon: ActivityIcon },
] as const;

function DevelopmentIcons() {
  return (
    <div className="grid grid-cols-6 gap-6 p-6">
      {icons.map(({ name, Icon }) => (
        <div key={name} className="flex flex-col items-center gap-2">
          <Icon className="h-8 w-8" />
          <span className="text-xs text-muted-foreground">{name}</span>
        </div>
      ))}
    </div>
  );
}

const meta = {
  title: 'Registries/LucideAnimated/Development',
  component: DevelopmentIcons,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof DevelopmentIcons>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
