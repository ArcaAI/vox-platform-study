import type { Meta, StoryObj } from "@storybook/react-vite";
import { UsageTable } from "@/components/registries/billingsdk";

const meta = {
  title: "Registries/BillingSDK/UsageTable",
  component: UsageTable,
  parameters: { layout: "centered" },
  tags: ["autodocs"],
} satisfies Meta<typeof UsageTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    title: "Usage",
    description: "API usage",
    usageHistory: [
      {
        model: "GPT-4",
        inputWithCache: 1000,
        inputWithoutCache: 500,
        cacheRead: 0,
        output: 2000,
        totalTokens: 3500,
      },
    ],
  },
};
