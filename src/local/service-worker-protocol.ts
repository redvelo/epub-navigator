export interface LocalServiceWorkerConfiguration {
  readonly type: "configure";
  readonly mountBaseUrl: string;
  readonly measurementMountBaseUrl: string;
  readonly contentAgentUrl: string;
  readonly readerFontStylesheetUrl: string | null;
}

export const localServiceWorkerCacheName = "epub-navigator-host";

export function localServiceWorkerConfigurationRequest(): Request {
  return new Request("https://epub-navigator.invalid/host/configuration.json");
}

export interface LocalServiceWorkerConfigured {
  readonly type: "configured";
}

export interface LocalServiceWorkerConfigurationError {
  readonly type: "configuration-error";
  readonly message: string;
}

export type LocalServiceWorkerMessage =
  | LocalServiceWorkerConfiguration
  | LocalServiceWorkerConfigured
  | LocalServiceWorkerConfigurationError;
