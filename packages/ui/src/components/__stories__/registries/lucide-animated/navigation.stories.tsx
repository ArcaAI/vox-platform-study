import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MenuIcon,
  HomeIcon,
  ExpandIcon,
  ShrinkIcon,
} from "@/components/registries/lucide-animated";

const icons = [
  { name: "arrow-down", Icon: ArrowDownIcon },
  { name: "arrow-up", Icon: ArrowUpIcon },
  { name: "arrow-left", Icon: ArrowLeftIcon },
  { name: "arrow-right", Icon: ArrowRightIcon },
  { name: "chevron-down", Icon: ChevronDownIcon },
  { name: "chevron-up", Icon: ChevronUpIcon },
  { name: "chevron-left", Icon: ChevronLeftIcon },
  { name: "chevron-right", Icon: ChevronRightIcon },
  { name: "menu", Icon: MenuIcon },
  { name: "home", Icon: HomeIcon },
  { name: "expand", Icon: ExpandIcon },
  { name: "shrink", Icon: ShrinkIcon },
] as const;

function NavigationIcons() {
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
  title: "Registries/LucideAnimated/Navigation",
  component: NavigationIcons,
  parameters: { layout: "padded" },
} satisfies Meta<typeof NavigationIcons>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
