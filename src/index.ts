/**
 * The package entry: everything in `api.ts`, plus the engine itself.
 *
 * The split is deliberate. `PdfEngine` is a value, so exporting it means
 * importing the module that owns it, and that module imports MuPDF - whose wasm
 * is 10 MB and is fetched the moment the module is evaluated. A page that draws
 * with a worker or an inline viewer by handing bytes to `createViewer` never
 * needs the engine on the main thread, and importing this file would make it pay
 * for one anyway. Those pages import `./api.ts`; a host that wants `PdfEngine`
 * imports this, which is what the package exports.
 *
 * `configureEngineWasm` is the other half of that: it is how a host says where
 * the wasm may be fetched from (a versioned CDN URL with a digest, a copy of its
 * own to fall back to) before anything asks for the engine. See `engine-wasm.ts`.
 */

export * from './api.ts';
export { PdfEngine, DocumentNotOpenError, PasswordRequiredError } from './core/engine.ts';
export { configureEngineWasm } from './core/engine-wasm.ts';
export type { EngineWasmConfig, EngineWasmSource } from './core/engine-wasm.ts';
