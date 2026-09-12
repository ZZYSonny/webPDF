//! Building the document's fonts, and the plan that decides what each one is.
//!
//! The outlines come from MuPDF (`plan.rs`), the compilation is here
//! (`build.rs`), and the names a ligature is read from come out of the
//! document's own font programs (`names.rs`, `program.rs`).

pub mod build;
pub mod names;
pub mod plan;
pub mod program;
pub mod woff;
