// Build the smallest possible font through the real builder, so a browser's
// verdict on it can be bisected.
use webpdf_core::font::build::{build_font, Cmd, Ligature, OutlineGlyph};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let variant = args.get(2).map(|s| s.as_str()).unwrap_or("plain");
    let square = vec![
        Cmd::Move(0.1, 0.0),
        Cmd::Line(0.5, 0.0),
        Cmd::Line(0.5, 0.7),
        Cmd::Line(0.1, 0.7),
        Cmd::Close,
    ];
    let curve = vec![
        Cmd::Move(0.05, 0.0),
        Cmd::Curve(0.05, 0.4, 0.3, 0.7, 0.55, 0.7),
        Cmd::Line(0.55, 0.0),
        Cmd::Close,
        Cmd::Move(0.2, 0.2),
        Cmd::Line(0.4, 0.2),
        Cmd::Line(0.4, 0.5),
        Cmd::Line(0.2, 0.5),
        Cmd::Close,
    ];
    let mut glyphs = vec![
        OutlineGlyph { gid: 1, cmds: square.clone(), codes: vec![0x41], advance_em: Some(0.6) },
        OutlineGlyph { gid: 2, cmds: curve.clone(), codes: vec![0x42], advance_em: Some(0.6) },
    ];
    if variant == "pua" {
        glyphs[1].codes = vec![0xe000];
    }
    let ligatures = if variant == "liga" {
        vec![Ligature { letters: vec![1, 2], by: 2 }]
    } else {
        vec![]
    };
    let font = build_font(&glyphs, &ligatures, "tiny-test", 1000).expect("build");
    std::fs::write(&args[1], &font.data).expect("write");
    println!("{} bytes, {} glyphs, variant {variant}", font.data.len(), font.glyph_count);
}
