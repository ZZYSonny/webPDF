// What the crop rules see: every span, with its box, and every drawing box.
//
//   webpdf-core-spans <pdf> <page>
//
// The reference pipeline is `readSpans`/`readDrawings` in the TypeScript engine
// this port replaces; this prints the same thing so the two can be held to each
// other rather than to a description of each other.
use webpdf_core::crop;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&args[1]).expect("read pdf");
    let page_no: i32 = args[2].parse().expect("page number");
    let doc = mupdf::Document::from_bytes(&bytes, "application/pdf").expect("open");
    let page = doc.load_page(page_no).expect("load page");

    let spans = crop::page_spans(&page).expect("spans");
    println!("{} spans", spans.len());
    for span in &spans {
        println!("  {} {}", span.box_.json(), webpdf_core::json::quote(&span.text));
    }
    let drawings = crop::page_drawings(&page).expect("drawings");
    println!("{} drawings", drawings.len());
    for rect in &drawings {
        println!("  {}", rect.json());
    }
}
