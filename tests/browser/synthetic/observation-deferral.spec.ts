import { expect, test } from "@playwright/test";
import { runScenario } from "./agent-scenario.js";

test("defers observations until a layout transaction settles", async ({ page }) => {
  const result = await runScenario(
    page,
    async ({ frame, layout, messages, clearMessages, delivered, quiesce, waitFor }) => {
      await quiesce();
      clearMessages();
      const pending = layout(1);
      await delivered();
      frame.contentDocument?.body.append(" mutation during layout ");
      const settled = await pending;
      const resultIndex = messages.indexOf(settled);
      await waitFor(() =>
        messages.slice(resultIndex + 1).some((message) => message.type === "observation"),
      );
      await quiesce();
      return {
        result: settled,
        observationsBeforeResult: messages
          .slice(0, resultIndex)
          .filter((message) => message.type === "observation").length,
        observationsAfterResult: messages
          .slice(resultIndex + 1)
          .filter((message) => message.type === "observation").length,
      };
    },
  );

  expect(result.result).toMatchObject({
    result: { adapter: "reflowable-xhtml", outcome: { status: "settled" } },
  });
  expect(result.observationsBeforeResult).toBe(0);
  expect(result.observationsAfterResult).toBe(1);
});
