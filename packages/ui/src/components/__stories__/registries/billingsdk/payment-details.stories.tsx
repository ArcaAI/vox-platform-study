import type { Meta, StoryObj } from "@storybook/react-vite";
import { PaymentDetails } from "@/components/registries/billingsdk";

const meta = {
  title: "Registries/BillingSDK/PaymentDetails",
  component: PaymentDetails,
  parameters: { layout: "centered" },
  tags: ["autodocs"],
} satisfies Meta<typeof PaymentDetails>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
};
