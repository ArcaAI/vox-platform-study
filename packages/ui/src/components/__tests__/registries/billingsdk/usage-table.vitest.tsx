import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { UsageTable } from "@/components/registries/billingsdk";

describe("UsageTable", () => {
  it("renders without crashing", () => {
    const { container } = render(
      <UsageTable
        title="Usage"
        usageHistory={[
          {
            model: "GPT-4",
            inputWithCache: 100,
            inputWithoutCache: 50,
            cacheRead: 0,
            output: 200,
            totalTokens: 350,
          },
        ]}
      />
    );
    expect(container.firstChild).toBeTruthy();
  });
});
