# Scratch script review

Inventory of `.js`, `.mjs`, `.ts`, `.py` and `.sh` files recursively under `.scratch`, excluding dependency/build target directories. HTML pages, PDFs, images, logs, Rust/C source and binary outputs are not script candidates. This is a source/coverage review, not a claim that every historical script was executed. Scratch files remain untouched.

Related probes are consolidated into maintained TypeScript tests. “Ported” means the reusable assertion or measurement was adapted, not every debugging print or obsolete code path copied. “Existing” means the relevant product behavior already has coverage; it does not claim every historical experiment is identical.

## Test tiers

- `npm run test:fast`: typechecking, Node tests, all generated WASM tests, a production demo build and the short browser regression suite. No corpus download or native Rust build. Requires built WASM and Chromium.
- `npm run test:complete`: typechecking, Node/native Rust tests, fresh native font-outline checks across the corpus, all-page WASM corpus checks, both browser regression modes, pixel checks and existing demo/modes/pinch/bridge/PWA/extension suites. Missing corpus files are downloaded; native probes are built.
- `npm run test:corpus`: first/middle/last pages per document. Append `-- --complete` for every page, or PDF paths to use your own documents.
- `npm run bench:core`: warmed render medians/maxima on sampled corpus pages. Append `-- --complete` for all pages. `WEBPDF_TEST_ENGINE` selects a different engine directory.
- `npm run test:dev`: the essential browser suite against Vite dev; included in the complete command.
- `npm run test:fonts`: generated-PDF native outline checks; `-- --complete` adds the corpus. Cold native builds can take minutes.

The fast browser case uses a 24-page generated PDF, A/B/A switching, remembered-page render order, two crop/revisit cycles and 60 scrolling frames. The complete case repeats both rendering modes, six crop cycles and 240 frames, then checks blob font URLs for every corpus document. Timings are reported; correctness failures fail the command. No fixed FPS threshold is used across different machines.

## Regression found while porting

The restored-page ordering check failed in progressive mode: page 1 was requested before the remembered page 8. The viewer now holds the initial render queue until the next animation frame, allowing the host to restore the position first. Both modes must request the restored page first. The older direct WASM smoke test also allocated only enough memory for a MIME string before copying an entire PDF; its allocation now matches the input length. The existing scrolling assertion now distinguishes genuinely visible pages from deferred pages behind the reader. Browser navigation clears unused deadline timers so they cannot extend test runtime.

## Coverage limits

The core corpus checks SVG structure, glyph/run statistics, bionic text/position invariants, font payload consistency, crop/link calls and save/reopen. The font-outline suite independently parses the compiled fonts and compares outlines, advances and unique cmap assignments against the native probe's source data. The ink suite checks bionic fading on the first page of each corpus PDF; it is not a whole-document MuPDF pixel-equivalence oracle. Historical renderer A/B comparisons and native-pinch sharpness experiments remain diagnostics, with their dependencies recorded below.

## Validation during this port

- `test:fast` passed in 9.1 seconds, including typechecking, 28 Node tests, 7 WASM tests (including 16 graphics pages), the demo build and short browser checks.
- All 40 native Rust tests passed. Fresh font dumps passed for 6,818 glyphs across the generated document and five corpus PDFs.
- The complete WASM corpus sweep passed on 941 pages, including SVG group balance. The benchmark path also ran successfully on all 15 pages of the Attention paper.
- The full browser command passed in 3 minutes 31 seconds: both regression modes, six ink comparisons, demo, rendering modes, pinch, bridge, PWA and extension suites. The dev-server variant passed separately in 4.9 seconds.

These are local measurements with cached PDFs and built WASM, not CI time limits. The complete command also runs native tests/font builds and the dev variant, so its total is longer than the browser command alone.

## Per-script disposition

263 script files inventoried. Diagnostic: 28, Existing: 20, Existing/diagnostic: 10, Existing/experiment: 18, Generated: 43, Ported: 27, Prototype: 4, Reference: 1, Reference diagnostic: 23, Retired experiment: 22, Retired pipeline: 67.

| Scratch path | Decision | Maintained coverage or reason |
| --- | --- | --- |
| `PaperCutter/cutter.py` | Reference | Third-party crop utility; native crop tests and browser/demo.ts cover the product. Do not copy the tool into tests. |
| `base14-probe.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `bionic-ab.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `bionic-diff.mjs` | Ported | core/checks.ts, core/render.test.ts and core/corpus.ts; text/position invariants |
| `bionic-ink.mjs` | Ported | browser/ink.ts; darkness and one-pixel mark coverage |
| `boot-probe.mjs` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `boot-probe2.mjs` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `build-e1.ts` | Existing/experiment | Variant build experiment; maintained build entry point is scripts/build-core-wasm.ts. |
| `build-one.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `build-var.ts` | Existing/experiment | Variant build experiment; maintained build entry point is scripts/build-core-wasm.ts. |
| `card-check.ts` | Existing | browser/demo.ts; shortcut card widths |
| `card-narrow.ts` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `card-shot.mjs` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `card-shot.ts` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `card-split-shot.ts` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `cff-probe.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `cff-strings.ts` | Prototype | Standalone font-conversion/shaping experiment, not the shipping implementation; retain for research. |
| `check-reported.mjs` | Ported | browser/regressions.ts; every used font family must be registered |
| `copy-probe.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `corpus-bench.mjs` | Ported | core/corpus.ts --benchmark; warm-up plus median/max render times |
| `corpus-check.mjs` | Reference diagnostic | Requires the old npm MuPDF/native-reference comparison setup. Not equivalent to the new ink check; retain as an external oracle, not a supported default test. |
| `corpus-dump.mjs` | Diagnostic | Artifact export for comparing engine variants; correctness and timing ported to core/corpus.ts, file-dump workflow retained in scratch. |
| `crop-ab.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `crop-drift.mjs` | Ported | browser/regressions.ts; preserve an interior page anchor through cropping |
| `crop-race.mjs` | Ported | browser/regressions.ts; revisit and replace pending crop work |
| `crop-shot.mjs` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `crop-state.mjs` | Ported | browser/regressions.ts; completion and visible text after crop |
| `dbg-boot.mjs` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `dbg-inject.mjs` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `dbg-inject2.mjs` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `dbg.mjs` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `debug-order.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `deepseek-example.mjs` | Ported | browser/regressions.ts; document switching and font registration |
| `deepseek-fonts.mjs` | Ported | core/checks.ts and core/corpus.ts; stylesheet/payload agreement across documents |
| `deepseek-repro.mjs` | Ported | browser/regressions.ts; generic generated-document font checks (not a DeepSeek visual baseline) |
| `deepseek-svg.mjs` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `deployed-glue.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `deployed-sw.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `dev-abort.mjs` | Ported | core/input.test.ts; open and error recovery |
| `dev-battery.mjs` | Ported | core/input.test.ts; malformed-input subset; encrypted input remains in browser/bridge.ts |
| `dev-check.mjs` | Ported | `test:dev` runs the generated browser checks against Vite dev, including absence of service-worker registration. |
| `dev-full.mjs` | Ported | core/wasm.ts and core/corpus.ts; current bridge API |
| `dev-sweep.mjs` | Ported | core/corpus.ts; explicit PDFs or the maintained corpus |
| `dict-survey.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `dump-all-fonts.mjs` | Reference diagnostic | Font/PDF inspection using historical tooling; core/fonts.ts validates current font outlines, but does not replicate this exploratory report. |
| `dump-encoding.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `dump-font-bytes.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `dump-font-head.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `embed-noplan.mjs` | Ported | core/render.test.ts; pre-plan render and planned inline/named font modes |
| `enc-probe.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `enc-probe2.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `encode-sweep.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `engine-api/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-baseline/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-closure/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-ctors/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-dev/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-e1/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-e2/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-e3/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-e4/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-e5/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-emmalloc/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-fs0/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-inc/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-noICC/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-noJPX/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-nocjk/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-noeval/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-nofont/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-nolto/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `engine-plan-probe.mjs` | Generated | Build/deployment artifact, not a test source; no port. |
| `export-size.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `ext/bundled/app/assets/__vite-browser-external-9wXp6ZBx.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `ext/bundled/app/assets/__vite-browser-external-BIHI7g3E.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `ext/bundled/app/assets/engine-BqZBXMi9.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `ext/bundled/app/assets/index-BVuayrDY.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `ext/bundled/app/assets/pdf.worker-B2E5bkuO.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `ext/bundled/app/host-mode.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `ext/bundled/assets/history-CLBeE7gZ.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `ext/bundled/background.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `ext/bundled/viewer.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `ext/latest/assets/history-CLBeE7gZ.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `ext/latest/background.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `ext/latest/viewer.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `ext-cold.mjs` | Existing/diagnostic | browser/extension.ts covers interception, restore and reopening; worker/target dumps remain debugging tools. |
| `ext-latest.mjs` | Existing/diagnostic | browser/extension.ts covers interception, restore and reopening; worker/target dumps remain debugging tools. |
| `ext-latest2.mjs` | Existing/diagnostic | browser/extension.ts covers interception, restore and reopening; worker/target dumps remain debugging tools. |
| `ext-latest3.mjs` | Existing/diagnostic | browser/extension.ts covers interception, restore and reopening; worker/target dumps remain debugging tools. |
| `ext-place.mjs` | Existing/diagnostic | browser/extension.ts covers interception, restore and reopening; worker/target dumps remain debugging tools. |
| `ext-reopen.mjs` | Existing/diagnostic | browser/extension.ts covers interception, restore and reopening; worker/target dumps remain debugging tools. |
| `ext-restart.mjs` | Existing/diagnostic | browser/extension.ts covers interception, restore and reopening; worker/target dumps remain debugging tools. |
| `ext-rules.mjs` | Existing/diagnostic | browser/extension.ts covers interception, restore and reopening; worker/target dumps remain debugging tools. |
| `ext-smoke.mjs` | Existing/diagnostic | browser/extension.ts covers interception, restore and reopening; worker/target dumps remain debugging tools. |
| `ext-trace.mjs` | Existing/diagnostic | browser/extension.ts covers interception, restore and reopening; worker/target dumps remain debugging tools. |
| `fffd-probe.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `final-shot.mjs` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `find-anchor.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `flash-probe.mjs` | Existing | browser/modes.ts; frame-by-frame handover coverage |
| `font-check.mjs` | Ported | core/font-outlines.ts and core/fonts.ts; fresh native font dumps |
| `font-cmap-probe.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `font-handle-probe.mjs` | Reference diagnostic | Font/PDF inspection using historical tooling; core/fonts.ts validates current font outlines, but does not replicate this exploratory report. |
| `font-link-probe.mjs` | Reference diagnostic | Font/PDF inspection using historical tooling; core/fonts.ts validates current font outlines, but does not replicate this exploratory report. |
| `font-order-probe.mjs` | Reference diagnostic | Font/PDF inspection using historical tooling; core/fonts.ts validates current font outlines, but does not replicate this exploratory report. |
| `font-plan-probe.mjs` | Reference diagnostic | Font/PDF inspection using historical tooling; core/fonts.ts validates current font outlines, but does not replicate this exploratory report. |
| `font-plan-probe2.mjs` | Reference diagnostic | Font/PDF inspection using historical tooling; core/fonts.ts validates current font outlines, but does not replicate this exploratory report. |
| `font-share.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `font-survey.mjs` | Reference diagnostic | Font/PDF inspection using historical tooling; core/fonts.ts validates current font outlines, but does not replicate this exploratory report. |
| `font-tables.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `font-uri.ts` | Ported | browser/regressions.ts; fetch blob URLs and explicitly load every registered face |
| `fontformats.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `fontkit-probe.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `frame-cost-page.js` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `frame-cost.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `frames-ab.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `frames-probe.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `frames-scroll-detail.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `frames-smoke.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `gh-pages-serve.mjs` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `gid-debug.mjs` | Reference diagnostic | Font/PDF inspection using historical tooling; core/fonts.ts validates current font outlines, but does not replicate this exploratory report. |
| `gid-range.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `glyph-by-gid.mjs` | Reference diagnostic | Font/PDF inspection using historical tooling; core/fonts.ts validates current font outlines, but does not replicate this exploratory report. |
| `glyph-by-gid2.mjs` | Reference diagnostic | Font/PDF inspection using historical tooling; core/fonts.ts validates current font outlines, but does not replicate this exploratory report. |
| `glyph-counts.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `glyph-dev.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `glyph-sequence-probe.mjs` | Reference diagnostic | Font/PDF inspection using historical tooling; core/fonts.ts validates current font outlines, but does not replicate this exploratory report. |
| `head-engine/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `iframe-econ-1.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `iframe-econ-2.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `iframe-econ-2b.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `iframe-econ-3.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `iframe-econ-4.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `iframe-econ-4b.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `iframe-econ-5.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `iframe-econ-6.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `iframe-econ-lib.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `iframe-econ-mkwoff.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `iframe-econ-pngtest.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `iframe-econ-smoke.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `inject.js` | Diagnostic | Trace/profile/invalidation or screenshot investigation; timing and insertion checks consolidated in browser/regressions.ts. Do not turn trace dumps into flaky gates. |
| `injected.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `injected2.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `injected3.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `inspect-crop.mjs` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `inspect2.mjs` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `js-chars.mjs` | Reference diagnostic | Font/PDF inspection using historical tooling; core/fonts.ts validates current font outlines, but does not replicate this exploratory report. |
| `js-font.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `js-letters.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `js-place.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `kept-header.mjs` | Existing | browser/pwa.ts; tests actual engine eviction including stale-client refetch |
| `keys.ts` | Existing | browser/demo.ts; shortcuts and editable controls |
| `letters-ab.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `letters-dict.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `letters-profile.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `liga-browser-probe.mjs` | Reference diagnostic | Font/PDF inspection using historical tooling; core/fonts.ts validates current font outlines, but does not replicate this exploratory report. |
| `liga-check2.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `liga-code.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `liga-missing.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `liga-named.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `ligature-font-probe.mjs` | Prototype | Standalone font-conversion/shaping experiment, not the shipping implementation; retain for research. |
| `make-features.py` | Ported | helpers/features.ts and core/features.test.ts; all 16 pages, corrected pattern colour space and mesh data |
| `marks-near.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `names-probe.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `narrow.mjs` | Existing | browser/demo.ts; narrow layouts |
| `old-release/webpdf-core.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `open-plan-cost.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `opentype-quad.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `ot-probe.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `ot-tiny.mjs` | Prototype | Standalone font-conversion/shaping experiment, not the shipping implementation; retain for research. |
| `ots-probe.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `ots-why.mjs` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `overflow.mjs` | Existing | browser/demo.ts; toolbar overflow |
| `pack/ext/assets/history-CLBeE7gZ.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `pack/ext/background.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `pack/ext/viewer.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `page-cost.ts` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `page-phases.ts` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `perf-ab.mjs` | Diagnostic | Trace/profile/invalidation or screenshot investigation; timing and insertion checks consolidated in browser/regressions.ts. Do not turn trace dumps into flaky gates. |
| `perf-detail.mjs` | Diagnostic | Trace/profile/invalidation or screenshot investigation; timing and insertion checks consolidated in browser/regressions.ts. Do not turn trace dumps into flaky gates. |
| `perf-face.mjs` | Diagnostic | Trace/profile/invalidation or screenshot investigation; timing and insertion checks consolidated in browser/regressions.ts. Do not turn trace dumps into flaky gates. |
| `perf-fonts.mjs` | Ported | browser/regressions.ts; no duplicate font families after revisit |
| `perf-frames.mjs` | Ported | browser/regressions.ts; down/up frame p95 and max, no machine-specific FPS gate |
| `perf-insert.mjs` | Ported | browser/regressions.ts; real innerHTML insertion count and cost, no duplicate-swallow patch |
| `perf-invalidation.mjs` | Diagnostic | Trace/profile/invalidation or screenshot investigation; timing and insertion checks consolidated in browser/regressions.ts. Do not turn trace dumps into flaky gates. |
| `perf-profile.mjs` | Diagnostic | Trace/profile/invalidation or screenshot investigation; timing and insertion checks consolidated in browser/regressions.ts. Do not turn trace dumps into flaky gates. |
| `perf-trace.mjs` | Diagnostic | Trace/profile/invalidation or screenshot investigation; timing and insertion checks consolidated in browser/regressions.ts. Do not turn trace dumps into flaky gates. |
| `pinch/client.mjs` | Existing/experiment | browser/pinch.ts covers the current pinch/zoom contract. Static iframe/prototype matrices, PNG helpers and screenshots are capability experiments. |
| `pinch/make-real.mjs` | Existing/experiment | browser/pinch.ts covers the current pinch/zoom contract. Static iframe/prototype matrices, PNG helpers and screenshots are capability experiments. |
| `pinch/png.mjs` | Existing/experiment | browser/pinch.ts covers the current pinch/zoom contract. Static iframe/prototype matrices, PNG helpers and screenshots are capability experiments. |
| `pinch/probe-demo.mjs` | Existing/experiment | browser/pinch.ts covers the current pinch/zoom contract. Static iframe/prototype matrices, PNG helpers and screenshots are capability experiments. |
| `pinch/probe-demo2.mjs` | Existing/experiment | browser/pinch.ts covers the current pinch/zoom contract. Static iframe/prototype matrices, PNG helpers and screenshots are capability experiments. |
| `pinch/probe-demo3.mjs` | Existing/experiment | browser/pinch.ts covers the current pinch/zoom contract. Static iframe/prototype matrices, PNG helpers and screenshots are capability experiments. |
| `pinch/probe-desktop.mjs` | Existing/experiment | browser/pinch.ts covers the current pinch/zoom contract. Static iframe/prototype matrices, PNG helpers and screenshots are capability experiments. |
| `pinch/probe-flags.mjs` | Existing/experiment | browser/pinch.ts covers the current pinch/zoom contract. Static iframe/prototype matrices, PNG helpers and screenshots are capability experiments. |
| `pinch/probe-owner.mjs` | Existing/experiment | browser/pinch.ts covers the current pinch/zoom contract. Static iframe/prototype matrices, PNG helpers and screenshots are capability experiments. |
| `pinch/probe-real.mjs` | Existing/experiment | browser/pinch.ts covers the current pinch/zoom contract. Static iframe/prototype matrices, PNG helpers and screenshots are capability experiments. |
| `pinch/probe.mjs` | Existing/experiment | browser/pinch.ts covers the current pinch/zoom contract. Static iframe/prototype matrices, PNG helpers and screenshots are capability experiments. |
| `pinch/probe2.mjs` | Existing/experiment | browser/pinch.ts covers the current pinch/zoom contract. Static iframe/prototype matrices, PNG helpers and screenshots are capability experiments. |
| `pinch/server.mjs` | Existing/experiment | browser/pinch.ts covers the current pinch/zoom contract. Static iframe/prototype matrices, PNG helpers and screenshots are capability experiments. |
| `pinch/sharp2.mjs` | Existing/experiment | browser/pinch.ts covers the current pinch/zoom contract. Static iframe/prototype matrices, PNG helpers and screenshots are capability experiments. |
| `pinch/shot-final.mjs` | Existing/experiment | browser/pinch.ts covers the current pinch/zoom contract. Static iframe/prototype matrices, PNG helpers and screenshots are capability experiments. |
| `pinch/toolbar-shot.mjs` | Existing/experiment | browser/pinch.ts covers the current pinch/zoom contract. Static iframe/prototype matrices, PNG helpers and screenshots are capability experiments. |
| `place-near.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `plan-ab.mjs` | Existing | browser/modes.ts |
| `plan-cmap-check.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `plan-cost.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `plan-counts.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `plan-debug.mjs` | Existing | browser/modes.ts |
| `plan-decline.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `plan-ink.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `plan-null-outline.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `plan-probe.mjs` | Existing | browser/modes.ts |
| `plan-split.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `plan-text-diff.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `png-diff.mjs` | Diagnostic | Trace/profile/invalidation or screenshot investigation; timing and insertion checks consolidated in browser/regressions.ts. Do not turn trace dumps into flaky gates. |
| `print-probe.mjs` | Existing | browser/demo.ts; print handoff (OS print-dialog capability probe not automated) |
| `print-probe2.mjs` | Existing | browser/demo.ts and browser/bridge.ts; print/save and password paths |
| `probe-attach.mjs` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `probe-f3.mjs` | Reference diagnostic | Font/PDF inspection using historical tooling; core/fonts.ts validates current font outlines, but does not replicate this exploratory report. |
| `probe-load.mjs` | Existing | browser/modes.ts |
| `program-plan.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `pwa-debug.mjs` | Existing | browser/pwa.ts; offline and redeploy scenarios |
| `quad-count.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `quad-probe.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `raster-check.mjs` | Reference diagnostic | Requires the old npm MuPDF/native-reference comparison setup. Not equivalent to the new ink check; retain as an external oracle, not a supported default test. |
| `raster-map.mjs` | Reference diagnostic | Requires the old npm MuPDF/native-reference comparison setup. Not equivalent to the new ink check; retain as an external oracle, not a supported default test. |
| `raster-sweep.mjs` | Ported | Group-balance assertions in core/checks.ts, used by graphics and corpus tests. Reference raster comparisons still require the old external oracle and are not claimed as ported. |
| `ref-dump.ts` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `ref-png.mjs` | Reference diagnostic | Requires the old npm MuPDF/native-reference comparison setup. Not equivalent to the new ink check; retain as an external oracle, not a supported default test. |
| `ref-svg-size.mjs` | Reference diagnostic | Requires the old npm MuPDF/native-reference comparison setup. Not equivalent to the new ink check; retain as an external oracle, not a supported default test. |
| `ref-svg.mjs` | Reference diagnostic | Requires the old npm MuPDF/native-reference comparison setup. Not equivalent to the new ink check; retain as an external oracle, not a supported default test. |
| `render-js.mjs` | Reference diagnostic | Requires the old npm MuPDF/native-reference comparison setup. Not equivalent to the new ink check; retain as an external oracle, not a supported default test. |
| `restore-order.ts` | Ported | browser/regressions.ts; remembered page is the first render request |
| `results-table.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `reuse-survey.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `scope-page.js` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `scope-probe.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `scope2-page.js` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `scope2-probe.mjs` | Retired experiment | Per-page iframe/font-scoping architecture experiment. Current handover is in browser/modes.ts and scrolling in browser/regressions.ts. |
| `search-probe.mjs` | Existing | browser/demo.ts; search/bionic interactions |
| `second-open.mjs` | Ported | browser/regressions.ts; A/B/A in both modes in complete run |
| `sfnt-cmap.mjs` | Prototype | Standalone font-conversion/shaping experiment, not the shipping implementation; retain for research. |
| `sftt-peek.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `shortcuts-card.ts` | Existing | browser/demo.ts; responsive shortcut card |
| `sjlj/t_we.js` | Generated | Build/deployment artifact, not a test source; no port. |
| `spans-ab.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `spans-set.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `substitute-repertoire.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `svg-fonts.mjs` | Reference diagnostic | Font/PDF inspection using historical tooling; core/fonts.ts validates current font outlines, but does not replicate this exploratory report. |
| `svg-inventory.mjs` | Reference diagnostic | Font/PDF inspection using historical tooling; core/fonts.ts validates current font outlines, but does not replicate this exploratory report. |
| `svg-probe.mjs` | Ported | core/features.test.ts; assert emitted graphics structures |
| `switch-shots.mjs` | Existing | browser/modes.ts; handover assertions already exist; screenshot sequence remains diagnostic |
| `tail-check.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `ttf-inspect.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `two-docs.mjs` | Ported | core/render.test.ts; A/B/A on one current PdfEngine |
| `type1.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `ui-check.mjs` | Existing | browser/demo.ts; menus, widths and chrome |
| `walk-coverage.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `walk-split.mjs` | Retired pipeline | Imports the removed src/core renderer. Preserve as research; no direct runnable port. New core checks do not claim equivalence to the removed reference. |
| `wasm-sections.mjs` | Diagnostic | One-off inspection, screenshot, binary-size report or debug helper; no independent product assertion to promote. |
| `wasm-smoke.mjs` | Existing | core/wasm.ts |
| `zoom-crop.mjs` | Existing | browser/demo.ts; crop/zoom controls |
| `zoommenu.mjs` | Existing | browser/demo.ts; zoom menu |
