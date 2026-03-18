import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { UpdatePlanCard } from "@/components/registries/billingsdk";
import { plans } from "@/lib/billingsdk-config";

describe("UpdatePlanCard", () => {
  it("renders without crashing", () => {
    const { container } = render(
      <UpdatePlanCard
        currentPlan={plans[0]}
        plans={plans}
        onPlanChange={() => {}}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });
});
