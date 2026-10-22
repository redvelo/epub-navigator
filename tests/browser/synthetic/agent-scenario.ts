import type { Page } from "@playwright/test";
import type { ScenarioControls } from "./observation-deferral-main.js";

export async function runScenario<T>(
  page: Page,
  scenario: (controls: ScenarioControls) => Promise<T>,
): Promise<T> {
  await page.goto("/synthetic/observation-deferral.html");
  return page.evaluate(
    (source) => window.runAgentScenario(source),
    scenario.toString(),
  ) as Promise<T>;
}
