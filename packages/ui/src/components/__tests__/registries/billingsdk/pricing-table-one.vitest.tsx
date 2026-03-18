import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PricingTableOne } from "@/components/registries/billingsdk";
import { plans } from "@/lib/billingsdk-config";

describe("PricingTableOne", () => {
  it("renders without crashing", () => {
    const { container } = render(<PricingTableOne plans={plans} />);
    expect(container.firstChild).toBeTruthy();
  });
});
