import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  CheckIcon,
  CheckCheckIcon,
  CopyIcon,
  DownloadIcon,
  UploadIcon,
  SearchIcon,
  SettingsIcon,
  DeleteIcon,
  SquarePenIcon,
  PlusIcon,
  XIcon,
  RefreshCWIcon,
  UndoIcon,
  RedoIcon,
} from "@/components/registries/lucide-animated";

const icons = [
  { name: "check", Icon: CheckIcon },
  { name: "check-check", Icon: CheckCheckIcon },
  { name: "copy", Icon: CopyIcon },
  { name: "download", Icon: DownloadIcon },
  { name: "upload", Icon: UploadIcon },
  { name: "search", Icon: SearchIcon },
  { name: "settings", Icon: SettingsIcon },
  { name: "delete", Icon: DeleteIcon },
  { name: "square-pen", Icon: SquarePenIcon },
  { name: "plus", Icon: PlusIcon },
  { name: "x", Icon: XIcon },
  { name: "refresh-cw", Icon: RefreshCWIcon },
  { name: "undo", Icon: UndoIcon },
  { name: "redo", Icon: RedoIcon },
] as const;

function ActionIcons() {
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
  title: "Registries/LucideAnimated/Actions",
  component: ActionIcons,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ActionIcons>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
