import { expect, test } from "@playwright/test";

test("runs an origin-root publication with exact isolated-origin messaging", async ({ page }) => {
  const pageErrors: Error[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto("/synthetic/isolated-origin.html");
  const result = page.locator("#result");
  await expect
    .poll(() => result.getAttribute("data-state"), { timeout: 10_000 })
    .not.toBe("opening");
  const state = await result.getAttribute("data-state");
  if (state !== "ready") {
    throw new Error(`${await result.textContent()}\n${consoleErrors.join("\n")}`);
  }
  const value = JSON.parse(await result.evaluate((element) => element.textContent ?? "")) as {
    readerOrigin: string;
    publicationOrigin: string;
    sameOriginRejection: string;
    committed: { frame: { occurrence: number; resource: string } };
    reloaded: { frame: { occurrence: number; resource: string } };
    firstReport: HostConformanceReport;
    secondReport: HostConformanceReport;
    frameSrc: string;
    frameSandbox: string;
    parentCanAccessDocument: boolean;
    selectionCapture: any;
    annotationTargetGeneration: any;
    agentMessageOrigins: string[];
    runtimeMessageOrigins: string[];
    sameOriginSpoofIgnored: boolean;
  };

  expect(value.readerOrigin).toBe("http://127.0.0.1:4174");
  expect(value.publicationOrigin).toBe("http://localhost:4174");
  expect(value.publicationOrigin).not.toBe(value.readerOrigin);
  expect(value.sameOriginRejection).toContain("must be distinct from the reader origin");
  expect(value.committed).toMatchObject({ frame: { occurrence: 0, resource: probeResource } });
  expect(value.reloaded).toMatchObject({ frame: { occurrence: 0, resource: probeResource } });
  expect(value.frameSrc).toBe(`${value.publicationOrigin}/${probeResource}`);
  expect(value.frameSrc).not.toContain("/publications/alice/");
  expect(value.frameSandbox).toBe("allow-scripts allow-same-origin");
  expect(value.parentCanAccessDocument).toBe(false);
  expect(value.selectionCapture).toMatchObject({
    outcome: "completed",
    occurrence: 0,
    resource: probeResource,
    selection: {
      status: "captured",
      location: {
        kind: "range",
        occurrence: 0,
        resource: probeResource,
        evidence: expect.arrayContaining([
          expect.objectContaining({ kind: "browser-text-position" }),
          expect.objectContaining({
            kind: "rendered-text-quote",
            exact: "Publisher resources",
          }),
        ]),
      },
      basis: {
        participant: { kind: "primary", documentGeneration: 2 },
      },
    },
  });
  expect(value.annotationTargetGeneration).toMatchObject({
    outcome: "completed",
    occurrence: 0,
    resource: probeResource,
    result: { status: "unavailable", reason: "not-authored" },
  });
  expect(value.agentMessageOrigins).not.toHaveLength(0);
  expect(new Set(value.agentMessageOrigins)).toEqual(new Set([value.publicationOrigin]));
  expect(value.runtimeMessageOrigins).not.toHaveLength(0);
  expect(new Set(value.runtimeMessageOrigins)).toEqual(new Set([value.readerOrigin]));
  expect(value.sameOriginSpoofIgnored).toBe(true);

  expect(value.firstReport).toMatchObject({
    classicScript: "executed",
    staticModule: "unavailable-in-xhtml",
    dynamicModule: "dynamic-module-loaded",
    relativeFetch: "relative-fetch-loaded",
    rootRelativeFetch: "root-relative-fetch-loaded",
    previousLocalStorageValue: null,
    currentLocalStorageValue: "local-storage-value",
    previousIndexedDbValue: null,
    dedicatedWorker: "dedicated-worker-ready",
    dedicatedWorkerStaticModule: "static-module-loaded",
    serviceWorkerOutcome: "blocked-by-policy",
    serviceWorkerRegistrationPresent: false,
    remoteFetchBlocked: true,
    popupBlocked: true,
    rangeStatus: 206,
    rangeContentRange: "bytes 0-3/44",
    rangeBytes: [82, 73, 70, 70],
    stylesheetColor: "rgb(12, 34, 56)",
    imageLoaded: true,
  });
  expect(value.firstReport.serviceWorkerError).not.toBeNull();
  expect(value.secondReport).toMatchObject({
    previousLocalStorageValue: "local-storage-value",
    currentLocalStorageValue: "local-storage-value",
    previousIndexedDbValue: "indexed-db-value",
    serviceWorkerOutcome: "blocked-by-policy",
  });

  const publicationResponse = await page.request.get(value.frameSrc);
  expect(publicationResponse.ok()).toBe(true);
  expect(publicationResponse.headers()["access-control-allow-origin"]).toBeUndefined();
  expect(publicationResponse.headers()["content-security-policy"]).toContain(
    `frame-ancestors ${value.readerOrigin}`,
  );
  const missingResponse = await page.request.get(`${value.publicationOrigin}/isolated-origin.html`);
  expect(missingResponse.status()).toBe(404);
  const ordinaryServiceWorkerResponse = await page.request.get(
    `${value.publicationOrigin}/EPUB/js/service-worker.js`,
  );
  expect(ordinaryServiceWorkerResponse.status()).toBe(200);
  const serviceWorkerResponse = await page.request.get(
    `${value.publicationOrigin}/EPUB/js/service-worker.js`,
    { headers: { "Service-Worker": "script" } },
  );
  expect(serviceWorkerResponse.status()).toBe(403);
  const invalidRangeResponse = await page.request.get(
    `${value.publicationOrigin}/EPUB/media/silence.wav`,
    { headers: { Range: "bytes=999-1000" } },
  );
  expect(invalidRangeResponse.status()).toBe(416);
  expect(invalidRangeResponse.headers()["content-range"]).toBe("bytes */44");
  expect(pageErrors).toEqual([]);
});

interface HostConformanceReport {
  readonly classicScript: string | null;
  readonly staticModule: string;
  readonly dynamicModule: string;
  readonly relativeFetch: string;
  readonly rootRelativeFetch: string;
  readonly previousLocalStorageValue: string | null;
  readonly currentLocalStorageValue: string | null;
  readonly previousIndexedDbValue: string | null;
  readonly dedicatedWorker: string | null;
  readonly dedicatedWorkerStaticModule: string | null;
  readonly serviceWorkerOutcome: string;
  readonly serviceWorkerError: string | null;
  readonly serviceWorkerRegistrationPresent: boolean;
  readonly remoteFetchBlocked: boolean;
  readonly popupBlocked: boolean;
  readonly rangeStatus: number;
  readonly rangeContentRange: string | null;
  readonly rangeBytes: number[];
  readonly stylesheetColor: string;
  readonly imageLoaded: boolean;
}

const probeResource = "EPUB/text/conformance.xhtml";
