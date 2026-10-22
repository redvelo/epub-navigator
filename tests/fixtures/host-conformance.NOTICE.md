# Host Conformance EPUB Fixture

`host-conformance.epub` is generated from `host-conformance-src/` by:

```text
pnpm fixtures:host-conformance
```

The source and generated archive are maintained by the EPUB Navigator project and
are covered by the repository's `Apache-2.0 OR MIT` license. The fixture contains
no third-party assets. Its tiny WAV resource is generated from the checked-in
base64 source.

- Generated size: 6,101 bytes
- SHA-256: `bbe3457ddd3a69543d2a34bde50813cd6d0977e784bd04ce325c42e8c7aecd0f`
- Scenarios: isolated origin, classic scripts, document-module unavailability,
  module workers with static imports, dynamic import,
  same-origin and root-relative fetch, localStorage, IndexedDB, dedicated workers,
  blocked service workers, blocked remote fetch, blocked popups, CSS, SVG, audio,
  byte ranges, and cross-origin native selection capture.

Do not edit the generated EPUB directly.
