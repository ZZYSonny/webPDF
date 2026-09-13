//! Render pages of a PDF to SVG with the core, planning the document's fonts
//! first, and print what it cost.
//!
//!   webpdf-core <pdf> <out-dir> <page>...
//!
//! The environment is the probe's option surface, so every feature the bridge
//! exposes can be compared from a shell:
//!
//!   WPDF_BIONIC=1            bionic reading
//!   WPDF_BIONIC_DIM=0.35     how faint the rest of each word goes
//!   WPDF_LINKS=1             append link hit areas
//!   WPDF_CROP='^arXiv:;^\s*[0-9]+\s*$'   crop to the content minus these marks
//!   WPDF_CROP_PADDING=6      points of margin around the crop
//!   WPDF_SAVE=out.pdf        write the document out again
//!
//! `WPDF_CROP` is a `;`-separated list of regular expressions, because a shell
//! has no comfortable newline - which is what the wire uses. A reader's menu
//! sends the same list, and a run is left out of the crop box when any
//! expression in it matches anywhere in the run.

use std::env;
use std::fs;

use webpdf_core::crop;
use webpdf_core::{Core, RenderOptions};

fn main() {
    let args: Vec<String> = env::args().collect();
    let path = &args[1];
    let out_dir = &args[2];
    let pages: Vec<i32> = args[3..].iter().map(|s| s.parse().unwrap()).collect();

    fs::create_dir_all(out_dir).expect("create output directory");
    let bytes = fs::read(path).expect("read pdf");
    let mut core = Core::open(&bytes, "application/pdf").expect("open");
    let info = core.info();
    println!(
        "{path}: {} pages, title {:?}, {} bookmarks, encrypted {}",
        info.page_count,
        info.title,
        info.outline.len(),
        info.encrypted
    );

    let list = env::var("WPDF_CROP")
        .unwrap_or_default()
        .replace(';', crop::SEPARATOR);
    let patterns = crop::compile(&crop::parse_patterns(&list)).expect("WPDF_CROP patterns compile");
    let padding: f32 = env::var("WPDF_CROP_PADDING")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0.0);

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
    if let Ok(save) = env::var("WPDF_SAVE") {
        let written = core.save().expect("save");
        fs::write(&save, &written).expect("write saved pdf");
        println!("  saved {} bytes to {save}", written.len());
    }

    let opts = RenderOptions {
        responsive: false,
        embed_fonts: true,
        // Bionic reading is a reader's setting rather than a document's, so the
        // probe asks for it the way a host would.
        bionic: env::var("WPDF_BIONIC").is_ok_and(|v| v != "0"),
        bionic_dim: env::var("WPDF_BIONIC_DIM").ok().and_then(|v| v.parse().ok()),
        links: env::var("WPDF_LINKS").is_ok_and(|v| v != "0"),
        ..Default::default()
    };
    for p in pages {
        // The crop is measured first and applied as a `viewBox`, exactly as the
        // host does it: the box the patterns leave, grown by the padding, stopped
        // by the page.
        let view_box = match core.measure_crop(p, &patterns) {
            Ok(Some(box_)) => {
                let page = core
                    .document()
                    .load_page(p)
                    .and_then(|page| page.bounds())
                    .map(crop::Box2::from_rect)
                    .expect("page bounds");
                let padded = crop::pad_box(box_, padding, page);
                println!("  page {p} crop {} -> {}", box_.json(), padded.json());
                Some((padded.x, padded.y, padded.width, padded.height))
            }
            Ok(None) => None,
            Err(error) => {
                println!("  page {p} crop failed: {error}");
                None
            }
        };
        let opts = RenderOptions {
            view_box,
            ..opts.clone()
        };

        let started = std::time::Instant::now();
        let rendered = core.render_page(p, &opts).expect("render");
        let svg = rendered.svg;
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
            text.replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">"),
        )
        .expect("write text");
        let stats = rendered.stats;
        println!(
            "  page {p}: {} bytes in {:?} - {}x{} - {} glyphs, {} text, {} outlines, {} runs, \
             {} spaces, {} faded, {} images, {} shadings, {} links",
            svg.len(),
            started.elapsed(),
            rendered.width,
            rendered.height,
            stats.glyphs,
            stats.as_text,
            stats.as_outlines,
            stats.runs,
            stats.spaces,
            stats.faded,
            stats.images,
            stats.shades,
            rendered.links.len()
        );
    }
}
