use std::env;
use std::fs;

use webpdf_core::{Core, RenderOptions};

/// Render pages of a PDF to SVG with the core, planning the document's fonts
/// first.
///
///   webpdf-core <pdf> <out-dir> <page>...
fn main() {
    let args: Vec<String> = env::args().collect();
    let path = &args[1];
    let out_dir = &args[2];
    let pages: Vec<i32> = args[3..].iter().map(|s| s.parse().unwrap()).collect();
    let _ = pages;

    fs::create_dir_all(out_dir).expect("create output directory");
    let bytes = fs::read(path).expect("read pdf");
    let mut core = Core::open(&bytes, "application/pdf").expect("open");
    println!("{path}: {} pages", core.page_count().unwrap());

    let started = std::time::Instant::now();
    core.plan_fonts().expect("plan");
    let faces = core.faces();
    println!(
        "  planned in {:?}: {} faces, {} bytes{}",
        started.elapsed(),
        faces.len(),
        faces.iter().map(|f| f.bytes).sum::<usize>(),
        if core.warnings().is_empty() {
            String::new()
        } else {
            format!(", {} warnings", core.warnings().len())
        }
    );
    for warning in core.warnings().iter().take(5) {
        println!("    ! {warning}");
    }

    let opts = RenderOptions {
        responsive: false,
        embed_fonts: true,
        ..Default::default()
    };
    for p in pages {
        let started = std::time::Instant::now();
        let (svg, stats) = core.render_page(p, &opts).expect("render");
        let out = format!("{out_dir}/page-{p}.svg");
        fs::write(&out, &svg).expect("write");
        // The text a reader would copy, for comparison against the pipeline
        // this replaces: every tspan's characters, in order.
        let mut text = String::new();
        let mut rest = svg.as_str();
        while let Some(at) = rest.find("<tspan") {
            let Some(open) = rest[at..].find('>') else { break };
            let body = &rest[at + open + 1..];
            let Some(end) = body.find("</tspan>") else { break };
            text.push_str(&body[..end]);
            rest = &body[end + 8..];
        }
        fs::write(
            format!("{out_dir}/page-{p}.txt"),
            text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"),
        )
        .expect("write text");
        println!(
            "  page {p}: {} bytes in {:?} - {} glyphs, {} text, {} outlines, {} runs, {} spaces, \
             {} images, {} shadings",
            svg.len(),
            started.elapsed(),
            stats.glyphs,
            stats.as_text,
            stats.as_outlines,
            stats.runs,
            stats.spaces,
            stats.images,
            stats.shades
        );
    }
}
