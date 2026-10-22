import { expect, test } from "@playwright/test";

test("allows form semantics while host CSP blocks every form transport", async ({ page }) => {
  const transports: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/form-target/")) transports.push(request.url());
  });

  const probed = page.waitForRequest((request) =>
    request.url().includes("request-probe=form-policy"),
  );
  await page.goto("/synthetic/form-policy.html");
  const result = page.locator("#result");
  await expect(result).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  await probed;
  const value = JSON.parse((await result.textContent()) ?? "") as FormPolicyResult;

  expect(value.sandbox).toBe("allow-scripts allow-same-origin allow-forms");
  expect(value.finalUrl).toBe(value.initialUrl);
  expect(transports).toEqual([]);
  expect(value.probe.invalid).toEqual(["invalid-get"]);
  expect(value.probe.submit).toEqual(["invalid-get", "post", "request-submit", "cancelled"]);
  expect(new Set(value.probe.formdata)).toEqual(
    new Set(["invalid-get", "post", "request-submit", "direct-submit"]),
  );
  expect(value.probe.formdata).not.toContain("cancelled");
  expect(value.probe.cancelledHandlerRan).toBe(true);
  expect(value.attempts).toHaveLength(4);
  expect(value.attempts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: "http://localhost:4174/form-target/get", method: "get" }),
      expect.objectContaining({ action: "http://localhost:4174/form-target/post", method: "post" }),
      expect.objectContaining({
        action: "http://localhost:4174/form-target/request-submit",
        method: "get",
      }),
      expect.objectContaining({
        action: "http://localhost:4174/form-target/cancelled",
        method: "post",
      }),
    ]),
  );
  expect(value.attempts.some((attempt) => attempt.action?.endsWith("/direct-submit"))).toBe(false);
  for (const attempt of value.attempts) {
    expect(Object.keys(attempt).sort()).toEqual([
      "action",
      "method",
      "participant",
      "resolvedUrl",
      "target",
    ]);
    expect(JSON.stringify(attempt)).not.toContain("secret");
  }
});

interface FormPolicyResult {
  readonly sandbox: string;
  readonly initialUrl: string;
  readonly finalUrl: string;
  readonly probe: {
    readonly invalid: string[];
    readonly submit: string[];
    readonly formdata: string[];
    readonly cancelledHandlerRan: boolean;
  };
  readonly attempts: {
    readonly action: string | null;
    readonly resolvedUrl: string;
    readonly method: string;
    readonly target: string | null;
    readonly participant: unknown;
  }[];
}
