//! Put the spaces back into the page's text.
//!
//! MuPDF's outline mode draws a glyph by referencing its outline, and a space
//! has no outline to reference, so nothing is drawn for it. The page comes out
//! with its words run together - "Providedproperattributionisprovided" - and
//! that glued string is what a reader copies, what a spell checker sees, and
//! what any word-level tool has to work with.
//!
//! The text device knows better: it reports every character it read, spaces
//! included, each with the origin the character starts at. A space has no ink, so
//! writing the character back cannot change what the page looks like; all it
//! needs is somewhere to sit, and the character *after* a space starts exactly
//! where that space ended. Anchoring to the next character rather than to the
//! space's own box is also what keeps this correct for rotated text, where a
//! bounding box says nothing about the direction of the advance.
//!
//! Two things are not a space in the character stream but are one in the text: a
//! line break, which the device reports by ending a line rather than by writing a
//! character, and a space that some font does have an outline for, which the
//! device reports *and* the outline writer draws. The first is added, the second
//! is left to the glyph that already carries it.

use std::collections::HashMap;

use mupdf::{Error, Page, TextPageFlags};

/// How far apart two points that are meant to be the same one may be.
///
/// A twentieth of a point: far below any glyph, far above float noise.
pub const ANCHOR_EPSILON: f32 = 0.05;

/// One character the text device reported, at the origin it starts at.
#[derive(Clone, Copy, Debug)]
pub struct TextChar {
    pub text: char,
    pub x: f32,
    pub y: f32,
    /// Which line of the page it was read on. Consecutive lines are in order.
    pub line: usize,
}

/// Whether a mark is a character the page's own text has, or one a line break
/// stands for. The difference matters: a space may already be drawn as a glyph,
/// a break never is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpaceKind {
    Space,
    Break,
}

/// A space, and where to write it: the origin of the character it precedes.
///
/// `origin_x`/`origin_y` are where the page itself put the space, which is how a
/// space the document draws is told apart from one it only left a gap for.
#[derive(Clone, Copy, Debug)]
pub struct SpaceMark {
    pub kind: SpaceKind,
    pub origin_x: f32,
    pub origin_y: f32,
    pub x: f32,
    pub y: f32,
    pub code: u32,
}

/// The Unicode space separators, plus the tab.
///
/// Only characters that are *spaces*: a line break is where the text device ends
/// a line, not a character with a position, and inserting one into the middle of
/// a run would be a lie about the document.
pub fn is_space_char(text: char) -> bool {
    matches!(
        text,
        '\t' | '\u{20}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
    )
}

/// Every space in `chars`, each pointing at the character it precedes, plus one
/// for every line break.
///
/// A run of spaces points at the *same* character: two spaces in a row both sit
/// in front of the next word, and keeping them in order is what makes them come
/// out as two spaces. Trailing whitespace - a space with nothing after it on the
/// page - is dropped: there is no glyph to attach it to, and no text for it to
/// separate.
pub fn space_marks(chars: &[TextChar]) -> Vec<SpaceMark> {
    let mut marks = Vec::new();
    let mut line: Option<usize> = None;

    for (i, char_) in chars.iter().enumerate() {
        if line != Some(char_.line) {
            let before = if i > 0 { chars.get(i - 1) } else { None };
            if let Some(before) = before {
                if !is_space_char(before.text) && !is_space_char(char_.text) {
                    marks.push(SpaceMark {
                        kind: SpaceKind::Break,
                        origin_x: char_.x,
                        origin_y: char_.y,
                        x: char_.x,
                        y: char_.y,
                        code: 0x20,
                    });
                }
            }
            line = Some(char_.line);
        }
        if !is_space_char(char_.text) {
            continue;
        }

        let mut j = i;
        while j < chars.len() && is_space_char(chars[j].text) {
            j += 1;
        }
        let Some(after) = chars.get(j) else { break };
        marks.push(SpaceMark {
            kind: SpaceKind::Space,
            origin_x: char_.x,
            origin_y: char_.y,
            x: after.x,
            y: after.y,
            code: char_.text as u32,
        });
    }
    marks
}

/// The characters the text device read, bucketed by the grid the anchors use.
///
/// A glyph the face draws nothing for - a space, and anything else that is
/// blank - is written as a character only when the device read *that character*
/// where the glyph is. A space at the end of a line is read as the line's break
/// instead, at the very point the space was drawn: writing the space for the
/// glyph would put a character into the text that the page does not have, which
/// is exactly how the space between two lines comes out twice.
pub struct CharGrid {
    cells: HashMap<(i64, i64), Vec<(f32, f32, u32)>>,
}

fn cell(v: f32) -> i64 {
    (v / ANCHOR_EPSILON).round() as i64
}

impl CharGrid {
    pub fn new(chars: &[TextChar]) -> Self {
        let mut cells: HashMap<(i64, i64), Vec<(f32, f32, u32)>> = HashMap::new();
        for char_ in chars {
            cells
                .entry((cell(char_.x), cell(char_.y)))
                .or_default()
                .push((char_.x, char_.y, char_.text as u32));
        }
        Self { cells }
    }

    /// Whether the device read a character *other* than this one at a point.
    ///
    /// A blank glyph - a space, and anything else the face draws nothing for -
    /// carries a character the page's own text may not have. MuPDF reports the
    /// space at the end of a line as the line's break instead, at the very point
    /// the space was drawn, and writing the glyph's space there would give the
    /// text a character the page does not have - which is how the space between
    /// two lines comes out twice. Anywhere else there is nothing to contradict
    /// it, and the glyph's own character is the page's.
    pub fn reads_other(&self, x: f32, y: f32, code: u32) -> bool {
        let (cx, cy) = (cell(x), cell(y));
        for dx in -1..=1 {
            for dy in -1..=1 {
                let Some(bucket) = self.cells.get(&(cx + dx, cy + dy)) else {
                    continue;
                };
                for (px, py, read) in bucket {
                    if (px - x).abs() <= ANCHOR_EPSILON
                        && (py - y).abs() <= ANCHOR_EPSILON
                        && *read != code
                    {
                        return true;
                    }
                }
            }
        }
        false
    }
}

/// Every character the text device has to say about a page, in reading order.
///
/// Text only: the vectors and images a crop rule wants are a different walk.
pub fn page_chars(page: &Page) -> Result<Vec<TextChar>, Error> {    let text_page = page.to_text_page(TextPageFlags::empty())?;
    let mut chars = Vec::new();
    let mut line = 0usize;
    for block in text_page.blocks() {
        for line_of_page in block.lines() {
            line += 1;
            for char_ in line_of_page.chars() {
                if let Some(text) = char_.char() {
                    let origin = char_.origin();
                    chars.push(TextChar {
                        text,
                        x: origin.x,
                        y: origin.y,
                        line,
                    });
                }
            }
        }
    }
    Ok(chars)
}

/// Ranges where a browser may reorder or reshape characters, which would break
/// MuPDF's already-resolved glyph positioning. Everything else - Latin, Greek,
/// Cyrillic, CJK, punctuation, Private Use Area - is safe to hand to the text
/// engine one code point per positioned glyph.
const UNSAFE_RANGES: &[(u32, u32)] = &[
    (0x0590, 0x08ff),    // Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic
    (0x0900, 0x0dff),    // Indic scripts
    (0x0e00, 0x0fff),    // Thai, Lao, Tibetan
    (0x1000, 0x109f),    // Myanmar
    (0x1100, 0x11ff),    // Hangul Jamo (needs composition)
    (0x1780, 0x17ff),    // Khmer
    (0x1900, 0x19ff),    // Limbu, New Tai Lue
    (0x1a00, 0x1cff),    // Buginese .. Lepcha
    (0xa800, 0xabff),    // Syloti Nagri .. Meetei Mayek
    (0xfb1d, 0xfdff),    // Hebrew/Arabic presentation forms
    (0xfe70, 0xfeff),    // Arabic presentation forms B
    (0x10800, 0x11fff),  // historic RTL and Indic scripts
    (0x1e800, 0x1efff),  // Mende Kikakui, Adlam
];

/// True when a code point can be handed to a text engine on its own.
pub fn is_simple_code(code: u32) -> bool {
    !UNSAFE_RANGES
        .iter()
        .any(|(lo, hi)| code >= *lo && code <= *hi)
}
