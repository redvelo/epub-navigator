# W3C EPUB 3.4 Roll Fixtures

These four official W3C EPUB binaries are unchanged. They are separate test
publications, not covered by navigator's Apache-2.0 OR MIT source license.
No catalogs, runtime contracts, production code, CSS, or native globals were changed.

## Provenance

- Repository: https://github.com/w3c/epub-tests
- Immutable source revision: `2d3b96756423189c0008eff95f0e98beda7cc5fe`
- Source: `https://github.com/w3c/epub-tests/tree/2d3b96756423189c0008eff95f0e98beda7cc5fe/tests/<id>/`
- Official binary: `https://w3c.github.io/epub-tests/tests/<id>.epub`
- Retrieved and checked: **2026-09-14 UTC**, from the system clock (the session's local date was September 13).
- Exact IDs, filenames, byte lengths, and binary SHA-256 digests: `manifest.json`.

The parent `tests/fixtures/` was inspected before creating this additive directory.
Each binary was downloaded with `curl --fail --location`; all four requests
returned HTTP 200. The served URLs are mutable, so the local SHA-256 values, not
those URLs alone, pin the binaries. They have not been regenerated or repacked.

Verification used `fflate.unzipSync`, XML parsing with JSDOM, and
`git ls-tree` / `git show` at the revision above. The complete non-directory ZIP
member sets and every member's uncompressed bytes matched the source tree:
25, 25, 24, and 26 members respectively in manifest order. This includes the
container, raw OPF metadata/manifest/spine, XHTML, SVG, CSS, and image bytes.
All four containers resolve to `EPUB/package.opf`, whose unrefined, package-global
`rendition:layout` is `roll`. No source mismatch or replacement revision was needed.
This verifies member content, not reproducibility of ZIP timestamps/compression.

## Runner Notes

`manifest.json` is a standalone fixture inventory, not an extension of the existing
corpus catalog contract. Runners should read the **raw** OPF manifest and spine
from the ZIP, resolve itemref IDs, and retain media types and fallback attributes;
the JSON is a concise inventory, not a replacement publication model.

| ID                             | OPF manifest                                                                | Ordered spine (9 items each)                                | Dimension source                                 |
| ------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| `lay-roll-embedded-images`     | 9 XHTML pages, 9 PNGs, nav, CSS, JPEG cover, XHTML cover                    | `texts/Title.xhtml`, then `texts/A.xhtml` through `H.xhtml` | Every viewport is 1674 x 1378                    |
| `lay-roll-embedded-images-svg` | Title XHTML + PNG, 8 SVG plates + 8 PNGs, nav, CSS, JPEG cover              | `texts/Title.xhtml`, then `plates/A.svg` through `H.svg`    | Title viewport and SVG `viewBox="0 0 1674 1378"` |
| `lay-roll-images-in-spine`     | 9 PNGs with 9 text-only XHTML fallbacks, nav, JPEG cover, XHTML cover       | `images/Title.png`, then `images/A.png` through `H.png`     | Every PNG IHDR is 1674 x 1378                    |
| `lay-roll-images-mixed`        | 7 XHTML pages + 2 text fallbacks, 9 PNGs, nav, CSS, JPEG cover, XHTML cover | Title, A, B XHTML; C, D PNG; E, F, G, H XHTML               | XHTML viewports and C/D PNG IHDR are 1674 x 1378 |

Paths in this table are relative to `EPUB/`. Covers are not in the spine.
The SVG archive also contains an unmanifested `texts/cover.xhtml`; the mixed
archive contains an unmanifested `images/UVWXYZ.png`. Both are present upstream
and intentionally retained. Archive equality is not a claim of EPUBCheck validity.

All nine intended spine surfaces have the same intrinsic/ICB size. At a uniform
fit-to-width scale for available width W, the expected surface height is
`W * 1378 / 1674`; nine adjacent surfaces total `9 * W * 1378 / 1674`, before any
host spacing or rounding. These are geometric expectations, not measured browser
page heights. The fixtures do not exercise varying intrinsic page heights.

Rendering references (`href`, `src`, including SVG `xlink:href`) in all XHTML/SVG
members resolve locally in each ZIP. CSS was inspected: no imports, URL assets,
or fonts; it sizes the HTML/body/figure to 100% height and constrains the image.
External OPF rights/specification links and the Library of Congress attribution
are metadata, not required rendering fetches. No external content server is needed.
There are nine distinct spine resource URLs, plus local dependent assets, not one
long content document. SVG plates reference sibling PNGs through relative URLs.

Live-view work remains: opt this inventory into a test-only host once the main
catalog/runner contract is decided; serve archive-relative resources with correct
MIME types; preserve SVG relative image resolution; select PNG spine resources
instead of silently substituting their text-only fallbacks; establish definite
ICB heights for percentage-height XHTML; and check scaled multi-resource roll
continuity and navigation in a browser. A fallback rendering is not visual
equivalence to the PNG test. The existing corpus entry point imports the separate
`epub3-samples/catalog` and these fixtures were deliberately not registered there.
No live browser run or production roll-support claim is made here.

## Attribution And License

W3C test publications by Ivan Herman and Susan Neuhaus. Original book:
_A Apple Pie_, Kate Greenaway (1846-1901), digitized by the US Library of Congress,
http://hdl.loc.gov/loc.rbc/bit.11404, identified by upstream as public domain.
All original publication metadata and notices are preserved inside the binaries.

Upstream `LICENSE.md` licenses EPUB documents under the
[W3C Software and Document License](https://www.w3.org/Consortium/Legal/copyright-software).
The individual OPFs explicitly link the
[2015 license](https://www.w3.org/Consortium/Legal/2015/copyright-software-and-document),
whose operative notice is reproduced below (copyright/trademark symbols rendered
as ASCII). The repository's general link currently resolves to the 2023 version;
both versions retain the permission and disclaimers below, with the 2023 example
copyright attribution identifying World Wide Web Consortium instead of its hosts.

This work is being provided by the copyright holders under the following license.

By obtaining and/or copying this work, you (the licensee) agree that you have read,
understood, and will comply with the following terms and conditions.

Permission to copy, modify, and distribute this work, with or without modification,
for any purpose and without fee or royalty is hereby granted, provided that you
include the following on ALL copies of the work or portions thereof, including
modifications:

- The full text of this NOTICE in a location viewable to users of the redistributed or derivative work.
- Any pre-existing intellectual property disclaimers, notices, or terms and conditions. If none exist, the W3C Software and Document Short Notice should be included: https://www.w3.org/Consortium/Legal/copyright-software-short-notice
- Notice of any changes or modifications, through a copyright statement on the new code or document such as "This software or document includes material copied from or derived from [title and URI of the W3C document]. Copyright (c) [YEAR] W3C (MIT, ERCIM, Keio, Beihang)."

THIS WORK IS PROVIDED "AS IS," AND COPYRIGHT HOLDERS MAKE NO REPRESENTATIONS OR
WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO, WARRANTIES OF
MERCHANTABILITY OR FITNESS FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF THE
SOFTWARE OR DOCUMENT WILL NOT INFRINGE ANY THIRD PARTY PATENTS, COPYRIGHTS,
TRADEMARKS OR OTHER RIGHTS.

COPYRIGHT HOLDERS WILL NOT BE LIABLE FOR ANY DIRECT, INDIRECT, SPECIAL OR
CONSEQUENTIAL DAMAGES ARISING OUT OF ANY USE OF THE SOFTWARE OR DOCUMENT.

The name and trademarks of copyright holders may NOT be used in advertising or
publicity pertaining to the work without specific, written prior permission.
Title to copyright in this work will at all times remain with copyright holders.
