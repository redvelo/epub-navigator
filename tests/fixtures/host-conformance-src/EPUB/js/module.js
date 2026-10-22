const readerOrigin = "http://127.0.0.1:4174";

window.addEventListener("error", (event) => {
  reportFailure(event.error instanceof Error ? event.error : new Error(event.message));
});
window.addEventListener("unhandledrejection", (event) => {
  reportFailure(event.reason instanceof Error ? event.reason : new Error(String(event.reason)));
});

window.addEventListener("message", (event) => {
  if (event.data?.namespace === "epub-navigator") {
    parent.postMessage(
      { type: "fixture-agent-message-origin", origin: event.origin },
      readerOrigin,
    );
  }
});

void run().catch(reportFailure);

async function run() {
  const dynamicModule = await import("/EPUB/js/dynamic-module.js");
  const relativeData = await fetch("../data/same-origin.json").then((response) => response.json());
  const rootData = await fetch("/EPUB/data/root-relative.json").then((response) => response.json());

  const localStorageKey = "epub-navigator-host-conformance";
  const previousLocalStorageValue = localStorage.getItem(localStorageKey);
  localStorage.setItem(localStorageKey, "local-storage-value");

  const database = await openDatabase();
  const previousIndexedDbValue = await readDatabase(database);
  await writeDatabase(database, "indexed-db-value");
  database.close();

  const dedicatedWorkerResult = await new Promise((resolve, reject) => {
    const worker = new Worker("../js/dedicated-worker.js", { type: "module" });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("dedicated worker timed out"));
    }, 2000);
    worker.addEventListener("message", (event) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(event.data ?? null);
    });
    worker.addEventListener("error", (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message));
    });
  });

  let serviceWorkerOutcome = "unsupported";
  let serviceWorkerError = null;
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("../js/service-worker.js", { scope: "../" });
      serviceWorkerOutcome = "registered";
    } catch (error) {
      serviceWorkerOutcome = "blocked-by-policy";
      serviceWorkerError = error instanceof Error ? error.name : String(error);
    }
  }
  const serviceWorkerRegistrationPresent =
    "serviceWorker" in navigator
      ? (await navigator.serviceWorker.getRegistration("../")) !== undefined
      : false;

  let remoteFetchBlocked = false;
  try {
    await fetch("https://example.invalid/blocked");
  } catch {
    remoteFetchBlocked = true;
  }

  const popupBlocked = window.open("https://example.invalid/popup", "_blank") === null;
  const rangeResponse = await fetch("../media/silence.wav", {
    headers: { Range: "bytes=0-3" },
  });
  const rangeBytes = new Uint8Array(await rangeResponse.arrayBuffer());
  const image = document.querySelector("img");
  if (image instanceof HTMLImageElement) await image.decode();

  parent.postMessage(
    {
      type: "host-conformance-report",
      classicScript: document.documentElement.dataset.hostConformanceClassic ?? null,
      staticModule: "unavailable-in-xhtml",
      dynamicModule: dynamicModule.dynamicModuleValue,
      relativeFetch: relativeData.value,
      rootRelativeFetch: rootData.value,
      previousLocalStorageValue,
      currentLocalStorageValue: localStorage.getItem(localStorageKey),
      previousIndexedDbValue,
      dedicatedWorker: dedicatedWorkerResult?.value ?? null,
      dedicatedWorkerStaticModule: dedicatedWorkerResult?.staticModuleValue ?? null,
      serviceWorkerOutcome,
      serviceWorkerError,
      serviceWorkerRegistrationPresent,
      remoteFetchBlocked,
      popupBlocked,
      rangeStatus: rangeResponse.status,
      rangeContentRange: rangeResponse.headers.get("Content-Range"),
      rangeBytes: Array.from(rangeBytes),
      stylesheetColor: getComputedStyle(document.getElementById("styled-probe")).color,
      imageLoaded: image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
    },
    readerOrigin,
  );
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("epub-navigator-host-conformance", 1);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore("state");
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function readDatabase(database) {
  return new Promise((resolve, reject) => {
    const request = database.transaction("state", "readonly").objectStore("state").get("value");
    request.addEventListener("success", () => resolve(request.result ?? null));
    request.addEventListener("error", () => reject(request.error));
  });
}

function writeDatabase(database, value) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("state", "readwrite");
    transaction.objectStore("state").put(value, "value");
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

function reportFailure(error) {
  parent.postMessage(
    { type: "host-conformance-error", name: error.name, message: error.message },
    readerOrigin,
  );
}
