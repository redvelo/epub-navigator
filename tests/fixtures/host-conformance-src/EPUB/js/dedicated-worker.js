import { staticModuleValue } from "./module-dependency.js";

self.postMessage({ value: "dedicated-worker-ready", staticModuleValue });
