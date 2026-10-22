import type { createStore } from "jotai";

/** The jotai store backing one reader instance. */
export type ReaderStore = ReturnType<typeof createStore>;
