import type { Meta, StoryObj } from "@storybook/react-vite";
import { PricingTableThree } from "@/components/registries/billingsdk";
import { plans } from "@/lib/billingsdk-config";

const meta = {
  title: "Registries/BillingSDK/PricingTableThree",
  component: PricingTableThree,
  parameters: { layout: "fullscreen" },
  tags: ["autodocs"],
} satisfies Meta<typeof PricingTableThree>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    plans,
  },
};
