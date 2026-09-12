//! The wasm entry point.
//!
//! Nothing runs here. A browser host drives the `wpdf_*` exports one call at a
//! time, and this `main` exists for the linker and not for the runtime:
//!
//!  - Emscripten links a *binary* as a main module and a `cdylib` as a side
//!    module, and only a main module can be started by Emscripten's own glue -
//!    which is the only glue that can set this module's C runtime up, because
//!    MuPDF is C. So the browser build is a bin.
//!  - A Rust rlib's `#[no_mangle]` functions are not reachable roots by default -
//!    the linker keeps an object only when something in it resolves an undefined
//!    symbol - so `keep_exports` names every one of them, and `-sEXPORTED_FUNCTIONS`
//!    is what turns the names into Emscripten exports.
//!
//! `main` returns immediately: `EXIT_RUNTIME` is off, so the runtime stays up and
//! the host calls into it for as long as the page lives.
fn main() {
    webpdf_core::wasm::keep_exports();
}
