// Which glyphs the plan leaves without a character, and why.
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
    println!("faces: {}", core.faces().len());
    for (name, seen, outlines, by_code, by_gid, letters, coded) in
        core.plan_for_probe().debug_entries()
    {
        println!(
            "  entry {name:32} seen {seen:5} outlines {outlines:5} by_code {by_code:5} by_gid {by_gid:5} letters {letters:4} coded {coded:5}"
        );
    }

    let doc = Document::from_bytes(&bytes, "application/pdf").unwrap();
    let page = PdfPage::try_from(doc.load_page(page_no).unwrap()).unwrap();
    let entries = core.plan_for_probe().page_entries(&page);
    let probe = Rc::new(RefCell::new(Probe::default()));
    {
        let dev = Device::from_native(probe.clone()).unwrap();
        page.run(&dev, &Matrix::IDENTITY).unwrap();
    }
    let p = probe.borrow();

    let mut by_font: HashMap<String, (usize, usize, Vec<(u32, i32)>)> = HashMap::new();
    for (name, gid, ucs) in &p.draws {
        let slot = by_font.entry(name.clone()).or_insert((0, 0, Vec::new()));
        slot.0 += 1;
        let missing = entries
            .get(name)
            .and_then(|e| core.plan_for_probe().face_for(*e))
            .map(|f| !f.code_of.contains_key(gid) && !f.letters_of.contains_key(gid))
            .unwrap_or(true);
        if missing {
            slot.1 += 1;
            slot.2.push((*gid, *ucs));
        }
    }
    let mut names: Vec<_> = by_font.iter().collect();
    names.sort_by_key(|(_, v)| std::cmp::Reverse(v.0));
    for (name, (total, missing, gids)) in names {
        let entry = entries.get(name);
        println!("{name:32} drawn {total:5} missing {missing:4} entry {entry:?}");
        if *missing > 0 {
            let mut sorted = gids.clone();
            sorted.sort_unstable();
            sorted.dedup();
            println!("    gid/ucs: {:?}", &sorted[..sorted.len().min(20)]);
        }
    }
}
