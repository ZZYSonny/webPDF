//! The little bit of JSON the core writes for its host.
//!
//! The wasm bridge hands a browser plain data - a document's title, a page's
//! links, a crop box - and JSON is what a browser reads without a schema. There
//! is no parser here because nothing is parsed: every value the core emits is one
//! it built itself, and a writer is a `String` and a match. Pulling in `serde`
//! for that would put a derive macro and a parser into the wasm module to save
//! sixty lines.

/// A string as a JSON string literal, quotes included.
///
/// Escapes what JSON requires and nothing else: the two characters that would
/// end the literal, the control characters below a space (which JSON has no
/// literal form for), and the line separators. A lone surrogate cannot occur -
/// a Rust `str` is valid UTF-8 - and every other character, including `</`, is
/// legal inside a JSON string, so an SVG or a URI passes through unescaped
/// except where it must not.
pub fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A `f32` as a JSON number: the shortest decimal that reads back as the same
/// float, and `null` for the values JSON has no spelling for.
pub fn number(value: f32) -> String {
    if !value.is_finite() {
        return "null".into();
    }
    format!("{value}")
}

/// An `Option<f32>` as a JSON number or `null`.
pub fn opt_number(value: Option<f32>) -> String {
    match value {
        Some(value) => number(value),
        None => "null".into(),
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn a_string_is_quoted_and_its_own_syntax_is_escaped() {
        assert_eq!(quote("plain"), "\"plain\"");
        assert_eq!(quote("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(quote("one\ntwo"), "\"one\\ntwo\"");
        assert_eq!(quote("bell\u{7}"), "\"bell\\u0007\"");
        // A slash needs no escape, and an SVG full of them keeps its bytes.
        assert_eq!(quote("</svg>"), "\"</svg>\"");
    }

    #[test]
    fn a_number_json_cannot_spell_is_null() {
        assert_eq!(number(1.5), "1.5");
        assert_eq!(number(-0.0), "-0");
        assert_eq!(number(f32::NAN), "null");
        assert_eq!(number(f32::INFINITY), "null");
        assert_eq!(opt_number(None), "null");
        assert_eq!(opt_number(Some(2.0)), "2");
    }
}
