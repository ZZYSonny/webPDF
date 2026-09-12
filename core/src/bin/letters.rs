// Every glyph the plan gave letters to, with the code the page drew it for, so a
// wrong ligature can be traced to the gid it was read from.
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use mupdf::pdf::PdfPage;
use mupdf::{ColorParams, Colorspace, Device, Document, Matrix, NativeDevice, Text};
use webpdf_core::Core;

#[derive(Default)]
struct Probe {
    draws: Vec<(String, u32, i32)>,
}

impl NativeDevice for Probe {
    fn fill_text(&mut self, text: &Text, _c: Matrix, _cs: &Colorspace, _co: &[f32], _a: f32, _p: ColorParams) {
        for span in text.spans() {
            let name = span.font().name().to_string();
            for item in span.items() {
                let gid = item.gid();
                if gid < 0 { continue; }
                self.draws.push((name.clone(), gid as u32, item.ucs()));
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let page_no: i32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let bytes = std::fs::read(&args[1]).unwrap();
    let mut core = Core::open(&bytes, "application/pdf").unwrap();
    core.plan_fonts().unwrap();
    let doc = Document::from_bytes(&bytes, "application/pdf").unwrap();
    let page = PdfPage::try_from(doc.load_page(page_no).unwrap()).unwrap();
    let entries = core.plan_for_probe().page_entries(&page);
    let probe = Rc::new(RefCell::new(Probe::default()));
    {
        let dev = Device::from_native(probe.clone()).unwrap();
        page.run(&dev, &Matrix::IDENTITY).unwrap();
    }
    let p = probe.borrow();
    let mut seen: HashMap<(String, u32, String), Vec<i32>> = HashMap::new();
    for (name, gid, ucs) in &p.draws {
        let Some(entry) = entries.get(name).copied() else { continue };
        let Some(face) = core.plan_for_probe().face_for(entry) else { continue };
        if let Some(letters) = face.letters_of.get(gid) {
            seen.entry((name.clone(), *gid, letters.clone())).or_default().push(*ucs);
        }
    }
    let mut list: Vec<_> = seen.into_iter().collect();
    list.sort_by(|a, b| a.0.cmp(&b.0));
    for ((name, gid, letters), ucs) in list {
        let mut ucs = ucs;
        ucs.sort_unstable();
        ucs.dedup();
        println!("{name:32} gid {gid:5} letters {letters:?} drawn for ucs {ucs:?}");
    }
}
