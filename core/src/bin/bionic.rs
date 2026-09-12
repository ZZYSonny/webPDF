// What the bionic segmenter makes of the strings it is given, for A/B against
// the TypeScript pipeline this core replaces (`src/core/svg/bionic.ts`).
//
//   bionic <in.txt> <out.json>   one input string per line -> one JSON array per line
//
// The strings are the page's text as the reader sees it, not escaped: the caller
// escapes and the segmenter puts the markup out of reach itself (`bionic.rs`).
use webpdf_core::bionic;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let input = std::fs::read_to_string(&args[1]).expect("read input");
    let mut out = String::new();
    let mut lines = 0;
    for line in input.lines() {
        lines += 1;
        out.push('[');
        for (i, segment) in bionic::segments(line).iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&format!(
                "{{\"fixation\":{},\"chars\":{},\"text\":{}}}",
                segment.fixation,
                segment.chars,
                json(&segment.text)
            ));
        }
        out.push_str("]\n");
    }
    std::fs::write(&args[2], out).expect("write output");
    println!("bionic {lines} strings");
}

/// A string as JSON, which is only ever the text the page itself has.
fn json(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
