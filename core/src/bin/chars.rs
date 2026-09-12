// Dump the text device's characters, to compare the reader this replaces.
use mupdf::pdf::PdfPage;
use mupdf::Document;
use webpdf_core::text::page_chars;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&args[1]).unwrap();
    let doc = Document::from_bytes(&bytes, "application/pdf").unwrap();
    let page = PdfPage::try_from(doc.load_page(args[2].parse().unwrap()).unwrap()).unwrap();
    let chars = page_chars(&page).unwrap();
    let mut out = String::from("[");
    for (i, c) in chars.iter().enumerate() {
        if i > 0 { out.push(','); }
        out.push_str(&format!("{{\"c\":{},\"x\":{},\"y\":{},\"line\":{}}}", c.text as u32, c.x, c.y, c.line));
    }
    out.push(']');
    std::fs::write(&args[3], out).unwrap();
    println!("rust chars {}", chars.len());
}
