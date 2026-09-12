//! Write a PDF out again with a password on it.
//!
//!   webpdf-encrypt <in.pdf> <out.pdf> <password>
//!
//! The viewer has to be able to *read* an encrypted document - it asks for the
//! password and hands it to the core - and the one interesting question about
//! that is what happens to a document the reader has answered for: the file on
//! disk still carries the password, so the copy the page prints or saves is
//! written out by the core instead (`Core::save` in `lib.rs`, and `documentBytes`
//! in `demo/main.ts`).
//!
//! There is no encrypted PDF in this repository - nothing here is a PDF at all -
//! so the browser suite makes one, and this is what makes it: the same library
//! that reads the document, writing it back with AES-256 and a user password.
//! MuPDF is the only thing here that can, and the core already links it.
//!
//! `--stdout` writes the bytes to standard output instead of a file, for a
//! caller that would rather not have a temporary file to clean up.
//!
//! ```text
//! cargo run --release --bin encrypt -- in.pdf out.pdf hunter2
//! ```

use std::env;
use std::fs;
use std::io::Write;

use mupdf::pdf::{Encryption, PdfWriteOptions};
use mupdf::{pdf::PdfDocument, Document};

fn main() {
    let args: Vec<String> = env::args().collect();
    let [_, input, output, password] = &args[..] else {
        eprintln!("usage: webpdf-encrypt <in.pdf> <out.pdf> <password>");
        std::process::exit(2);
    };

    let bytes = fs::read(input).expect("read the input");
    let doc = Document::from_bytes(&bytes, "application/pdf").expect("open the input");
    let pdf = PdfDocument::try_from(doc).expect("the input is not a PDF");

    // Both passwords are the same on purpose: this is a document a reader is
    // meant to be able to open with the password they were given, and an owner
    // password that differed would only mean the suite had one more thing to
    // remember. `Permission::all()` is what the reader may do once inside.
    let mut options = PdfWriteOptions::default();
    options
        .set_encryption(Encryption::Aes256)
        .set_user_password(password)
        .set_owner_password(password)
        .set_permissions(mupdf::pdf::Permission::all())
        .set_compress(true);

    let path = if output == "--stdout" { None } else { Some(output) };
    match path {
        Some(path) => {
            pdf.save_with_options(path, options).expect("write the copy");
            eprintln!("{input} -> {path} ({} bytes)", fs::metadata(path).map(|m| m.len()).unwrap_or(0));
        }
        None => {
            // The library has no buffer-based save, so the copy goes through a
            // file of its own and is read straight back - the same way the core's
            // `save` works, and the reason this is a separate binary rather than
            // a flag on the page.
            let scratch = std::env::temp_dir().join(format!("webpdf-encrypt-{}.pdf", std::process::id()));
            let scratch = scratch.to_string_lossy().into_owned();
            pdf.save_with_options(&scratch, options).expect("write the copy");
            let out = fs::read(&scratch).expect("read the copy back");
            let _ = fs::remove_file(&scratch);
            std::io::stdout().write_all(&out).expect("write to stdout");
        }
    }
}
