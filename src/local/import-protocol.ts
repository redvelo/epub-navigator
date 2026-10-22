import type { ImportProgress } from "./types.js";

export interface ImportWorkerStart {
  readonly type: "import";
  readonly source: ArrayBuffer;
}

export interface ImportWorkerCancel {
  readonly type: "cancel";
}

export type ImportWorkerRequest = ImportWorkerStart | ImportWorkerCancel;

export interface ImportWorkerProgress extends ImportProgress {
  readonly type: "progress";
  readonly id?: string | undefined;
}

export interface ImportWorkerDone {
  readonly type: "done";
  readonly id: string;
}

export interface ImportWorkerFailure {
  readonly type: "error";
  readonly message: string;
}

export type ImportWorkerResponse = ImportWorkerProgress | ImportWorkerDone | ImportWorkerFailure;
