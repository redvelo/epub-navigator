# EPUB Navigator Reader

The browser-local reader: the development harness for the runtime and the host the
Chromium corpus runs against. It imports EPUB archives in a worker, keeps them in
Cache Storage, and serves them from a service worker on the reader's own origin, so it
opens trusted books only. It is not a product; Elephant Ladder is.

The package build must run first so the reader build can copy the import worker,
service worker, content agent, and WASM files.

```sh
pnpm dev
pnpm build:reader
pnpm typecheck:reader
```

The reader defaults to adaptive light and dark publication colors, Reader Serif at
125%, and a wide reading width; the package itself defaults to a publication's original
styling, and a host opts into anything else.
