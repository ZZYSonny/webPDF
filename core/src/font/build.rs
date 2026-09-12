//! Build a web font from glyph outlines.
//!
//! The PDF pipeline never parses embedded font programs. MuPDF (through
//! FreeType) resolves every font - embedded CFF/Type 1/TrueType, substituted
//! base-14 faces, CJK - into normalised outlines, and `Font::outline_glyph`
//! hands those over in em units. Re-emitting them as a CFF charstring
//! guarantees the browser draws *exactly* the shape MuPDF would have drawn as a
//! path: nothing is approximated and no cubic is converted to a quadratic on the
//! way through.
//!
//! One thing a `cmap` cannot say is that a glyph is two letters: a character
//! maps to one glyph, and `fi` is two characters. So a font handed `Ligature`s
//! also gets a `GSUB` with the `liga` feature, which is how the text can say
//! `fi` - what a reader copies and searches for - while the browser draws the
//! one glyph the page drew.
//!
//! Glyphs with no character of their own are reachable from the Basic
//! Multilingual Plane's Private Use Area, `U+E000..U+F8FF`: it never collides
//! with real text, and it is the same range the pipeline used before, so the two
//! agree on what a page's text says.

/// Where a glyph with no character of its own is reachable from.
pub const PUA_BASE: u32 = 0xe000;
pub const PUA_LIMIT: u32 = 0xf8ff;

/// One drawing command of a glyph outline, in em units (1.0 == one em, y up).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Cmd {
    Move(f32, f32),
    Line(f32, f32),
    Curve(f32, f32, f32, f32, f32, f32),
    Close,
}

/// The box a command list occupies, control points included - the same box the
/// old SVG path scanner measured, so the advances derived from it agree.
#[derive(Clone, Copy, Debug, Default)]
pub struct Bounds {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

impl Bounds {
    pub fn of(cmds: &[Cmd]) -> Self {
        let (mut x0, mut y0) = (f32::INFINITY, f32::INFINITY);
        let (mut x1, mut y1) = (f32::NEG_INFINITY, f32::NEG_INFINITY);
        for cmd in cmds {
            let mut add = |x: f32, y: f32| {
                if x < x0 {
                    x0 = x;
                }
                if y < y0 {
                    y0 = y;
                }
                if x > x1 {
                    x1 = x;
                }
                if y > y1 {
                    y1 = y;
                }
            };
            match *cmd {
                Cmd::Move(x, y) | Cmd::Line(x, y) => add(x, y),
                Cmd::Curve(cx1, cy1, cx2, cy2, x, y) => {
                    add(cx1, cy1);
                    add(cx2, cy2);
                    add(x, y);
                }
                Cmd::Close => {}
            }
        }
        if !x0.is_finite() {
            return Self::default();
        }
        Self { x0, y0, x1, y1 }
    }
}

/// A glyph on its way into a font: its outline in em units, the codes it should
/// be reachable under, and the advance width the source declared.
#[derive(Clone, Debug, Default)]
pub struct OutlineGlyph {
    /// Glyph id inside the *source* font, as MuPDF numbers it.
    pub gid: u32,
    /// The outline, in em units, y up.
    pub cmds: Vec<Cmd>,
    /// Code points the glyph should be reachable under, real Unicode first.
    pub codes: Vec<u32>,
    /// Advance width in em units, when the source stated one.
    pub advance_em: Option<f32>,
}

impl OutlineGlyph {
    pub fn bounds(&self) -> Bounds {
        Bounds::of(&self.cmds)
    }
}

/// A ligature the built face should make: these letters, drawn as this glyph.
///
/// The glyph ids are the *source* ids the caller knows; the builder maps them to
/// the indices the compiled font uses.
#[derive(Clone, Debug)]
pub struct Ligature {
    /// Source glyph ids of the letters, in order.
    pub letters: Vec<u32>,
    /// Source glyph id that draws the letters together.
    pub by: u32,
}

/// A compiled font, ready to embed.
#[derive(Clone, Debug)]
pub struct BuiltFont {
    pub data: Vec<u8>,
    pub units_per_em: u32,
    pub glyph_count: usize,
}

/* ------------------------------------------------------------------ */
/* byte helpers                                                        */

fn u16be(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_be_bytes());
}
fn i16be(out: &mut Vec<u8>, v: i16) {
    out.extend_from_slice(&v.to_be_bytes());
}
fn u32be(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

/// A CFF DICT operand. Also what a Type 2 charstring operand is, except that the
/// 255 escape means a 16.16 fixed point there where it means a 32-bit integer in
/// a DICT; nothing here emits either, because a glyph coordinate is an integer
/// on the 1/1000 em grid by the time it is written.
fn dict_number(out: &mut Vec<u8>, v: i32) {
    if (-107..=107).contains(&v) {
        out.push((v + 139) as u8);
    } else if (108..=1131).contains(&v) {
        let v = v - 108;
        out.push((247 + (v >> 8)) as u8);
        out.push((v & 0xff) as u8);
    } else if (-1131..=-108).contains(&v) {
        let v = -v - 108;
        out.push((251 + (v >> 8)) as u8);
        out.push((v & 0xff) as u8);
    } else if (-32768..=32767).contains(&v) {
        out.push(28);
        out.extend_from_slice(&(v as i16).to_be_bytes());
    } else {
        out.push(29);
        out.extend_from_slice(&v.to_be_bytes());
    }
}

/// An offset operand and its operator, the operand always five bytes wide so it
/// can be patched in place once the thing it points at has been laid out.
fn dict_offset(out: &mut Vec<u8>, op: u8, marks: &mut Vec<(usize, u8)>) {
    out.push(29);
    marks.push((out.len(), op));
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.push(op);
}

fn patch_offsets(dict: &mut [u8], marks: &[(usize, u8)], values: &[(u8, u32)]) {
    for (at, op) in marks {
        for (key, value) in values {
            if key == op {
                dict[*at..*at + 4].copy_from_slice(&value.to_be_bytes());
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* the CFF table                                                       */

/// A CFF INDEX of `count` items.
fn cff_index(items: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    if items.is_empty() {
        u16be(&mut out, 0);
        return out;
    }
    u16be(&mut out, items.len() as u16);
    let total: usize = items.iter().map(|i| i.len()).sum();
    let last = total + 1; // offsets are 1-based
    let off_size: usize = if last <= 0xff {
        1
    } else if last <= 0xffff {
        2
    } else if last <= 0xff_ffff {
        3
    } else {
        4
    };
    out.push(off_size as u8);
    let push_offset = |out: &mut Vec<u8>, mut v: usize| {
        let mut bytes = [0u8; 4];
        for k in (0..off_size).rev() {
            bytes[k] = (v & 0xff) as u8;
            v >>= 8;
        }
        out.extend_from_slice(&bytes[..off_size]);
    };
    let mut at = 1usize;
    push_offset(&mut out, at);
    for item in items {
        at += item.len();
        push_offset(&mut out, at);
    }
    for item in items {
        out.extend_from_slice(item);
    }
    out
}

/// The 391 strings the CFF specification fixes (Appendix A), trimmed to the
/// prefix that matters here.
///
/// A charset names each glyph with a SID; SIDs below this table's length are one
/// of these strings and everything above it is in the font's own String INDEX.
/// Nothing downstream reads a glyph name - `post` is format 3 and the cmap is
/// what reaches a glyph - so the table is carried only so that `.notdef` has its
/// SID 0, and so that a name a charstring writer produced by hand cannot be
/// mistaken for a standard string.
const CFF_STANDARD_STRINGS: &[&str] = &["space", "exclam", "quotedbl"];

/// A Type 2 charstring for one glyph: the outline, and the width the source
/// declared.
///
/// The width is the first operand of the first stack-clearing operator when that
/// leaves an odd count, which is how a Type 2 charstring says how wide a glyph
/// is. It matters for the one place a browser lays a run out itself: a ligature,
/// whose letters are written as text and drawn as one glyph through `liga`.
fn charstring(glyph: &OutlineGlyph, upem: f32, width: i32) -> Vec<u8> {
    let mut out = Vec::new();
    let mut started = false;
    // The current point in *font units*, which is the space every operand is a
    // delta in. Comparing a scaled coordinate against an unscaled one here is how
    // a line ends up drawn to an absolute point somewhere off the glyph.
    let (mut cx, mut cy) = (0i32, 0i32);
    let scale = |v: f32| -> i32 { (v * upem).round() as i32 };

    for cmd in &glyph.cmds {
        match *cmd {
            Cmd::Move(x, y) => {
                if !started {
                    started = true;
                    if width != 0 {
                        dict_number(&mut out, width);
                    }
                }
                let (sx, sy) = (scale(x), scale(y));
                dict_number(&mut out, sx - cx);
                dict_number(&mut out, sy - cy);
                out.push(21); // rmoveto
                cx = sx;
                cy = sy;
            }
            Cmd::Line(x, y) => {
                let (sx, sy) = (scale(x), scale(y));
                dict_number(&mut out, sx - cx);
                dict_number(&mut out, sy - cy);
                out.push(5); // rlineto
                cx = sx;
                cy = sy;
            }
            Cmd::Curve(x1, y1, x2, y2, x, y) => {
                let (sx1, sy1) = (scale(x1), scale(y1));
                let (sx2, sy2) = (scale(x2), scale(y2));
                let (sx, sy) = (scale(x), scale(y));
                dict_number(&mut out, sx1 - cx);
                dict_number(&mut out, sy1 - cy);
                dict_number(&mut out, sx2 - sx1);
                dict_number(&mut out, sy2 - sy1);
                dict_number(&mut out, sx - sx2);
                dict_number(&mut out, sy - sy2);
                out.push(8); // rrcurveto
                cx = sx;
                cy = sy;
            }
            // Type 2 has no closepath: a contour ends where the next one begins.
            Cmd::Close => {}
        }
    }
    if !started && width != 0 {
        dict_number(&mut out, width);
    }
    out.push(14); // endchar
    out
}

struct FontGlyph<'a> {
    source: &'a OutlineGlyph,
    codes: Vec<u32>,
    advance: i32,
}

/// The `CFF ` table for a font whose glyph 0 is `.notdef`.
fn cff_table(glyphs: &[FontGlyph<'_>], family: &str, upem: f32) -> Vec<u8> {
    // `.notdef` gets a real charstring - a width and an `endchar` - rather than
    // an empty one: a charstring has to end with `endchar`, and a sanitizer that
    // reads the first glyph of the font first rejects the whole face over it.
    let notdef = charstring(&OutlineGlyph::default(), upem, (upem * 0.5).round() as i32);
    let charstrings: Vec<Vec<u8>> = std::iter::once(notdef)
        .chain(glyphs.iter().map(|g| charstring(g.source, upem, g.advance)))
        .collect();
    let charstrings_index = cff_index(&charstrings);

    // Names for the charset. Nothing reads them, but a charset has to name every
    // glyph, and a name that repeats is a name some loader will take for another
    // glyph - so each one is its own string in the font's String INDEX.
    let extra: Vec<Vec<u8>> = (1..=glyphs.len())
        .map(|i| format!("g{i}").into_bytes())
        .collect();
    let string_index = cff_index(&extra);

    let mut charset = vec![0u8]; // format 0: one SID per glyph after .notdef
    for i in 0..glyphs.len() {
        u16be(&mut charset, (CFF_STANDARD_STRINGS.len() + i) as u16);
    }

    // The private DICT says where a width comes from when a charstring carries
    // none: nowhere, so an absent width is zero rather than the last glyph's.
    let mut private = Vec::new();
    dict_number(&mut private, 0);
    private.push(20); // defaultWidthX
    dict_number(&mut private, 0);
    private.push(21); // nominalWidthX

    let name_index = cff_index(&[family.as_bytes().to_vec()]);
    let gsubr_index = cff_index(&[]);

    let (mut bbox_x0, mut bbox_y0) = (f32::INFINITY, f32::INFINITY);
    let (mut bbox_x1, mut bbox_y1) = (f32::NEG_INFINITY, f32::NEG_INFINITY);
    for g in glyphs {
        let b = g.source.bounds();
        bbox_x0 = bbox_x0.min(b.x0);
        bbox_y0 = bbox_y0.min(b.y0);
        bbox_x1 = bbox_x1.max(b.x1);
        bbox_y1 = bbox_y1.max(b.y1);
    }
    let bbox = if bbox_x0.is_finite() {
        [
            (bbox_x0 * upem).floor() as i32,
            (bbox_y0 * upem).floor() as i32,
            (bbox_x1 * upem).ceil() as i32,
            (bbox_y1 * upem).ceil() as i32,
        ]
    } else {
        [0, -200, 1000, 800]
    };

    // The top DICT's three offsets cannot be written until everything they point
    // at is laid out, so they go in as fixed-width placeholders and are patched
    // afterwards - which keeps every *other* offset in the DICT where it was.
    let sid_family = CFF_STANDARD_STRINGS.len() as i32 + extra.len() as i32;
    let mut top = Vec::new();
    let mut marks = Vec::new();
    let simple = |out: &mut Vec<u8>, v: i32, op: u8| {
        dict_number(out, v);
        out.push(op);
    };
    simple(&mut top, sid_family, 0); // version
    simple(&mut top, sid_family, 1); // Notice
    simple(&mut top, sid_family, 2); // FullName
    simple(&mut top, sid_family, 3); // FamilyName
    simple(&mut top, sid_family, 4); // Weight
    for v in bbox {
        dict_number(&mut top, v);
    }
    top.push(5); // FontBBox
    dict_offset(&mut top, 15, &mut marks); // charset
    simple(&mut top, 0, 16); // Encoding: Standard, which the cmap overrides
    dict_offset(&mut top, 17, &mut marks); // CharStrings
    dict_number(&mut top, private.len() as i32);
    dict_offset(&mut top, 18, &mut marks); // Private [size offset]
    if upem != 1000.0 {
        let s = (1.0 / upem * 1_000_000.0).round() as i32;
        for v in [s, 0, 0, s, 0, 0] {
            dict_number(&mut top, v);
        }
        top.push(12);
        top.push(7); // FontMatrix
    }

    // The placeholders are five bytes each and are patched in place, so the
    // DICT's length is already final - which is what lets the offsets be measured
    // before the DICT that carries them is encoded.
    let top_len = cff_index(std::slice::from_ref(&top)).len();
    let header_len = 4usize;
    let mut at =
        header_len + name_index.len() + top_len + string_index.len() + gsubr_index.len();
    let charset_at = at;
    at += charset.len();
    let charstrings_at = at;
    at += charstrings_index.len();
    let private_at = at;

    patch_offsets(
        &mut top,
        &marks,
        &[
            (15, charset_at as u32),
            (17, charstrings_at as u32),
            (18, private_at as u32),
        ],
    );
    let top_index = cff_index(&[top]);
    debug_assert_eq!(top_index.len(), top_len);

    let mut out = Vec::with_capacity(at + private.len());
    out.extend_from_slice(&[1, 0, 4, 1]); // major, minor, hdrSize, offSize
    out.extend_from_slice(&name_index);
    out.extend_from_slice(&top_index);
    out.extend_from_slice(&string_index);
    out.extend_from_slice(&gsubr_index);
    out.extend_from_slice(&charset);
    out.extend_from_slice(&charstrings_index);
    out.extend_from_slice(&private);
    out
}

/* ------------------------------------------------------------------ */
/* cmap                                                                */

/// One run of codes whose glyphs ascend with them, which is what a format 4
/// segment can express with a delta instead of a glyph array.
struct Segment {
    start: u32,
    end: u32,
    delta: i16,
}

fn segments(codes: &[(u32, u32)]) -> Vec<Segment> {
    let mut sorted: Vec<(u32, u32)> = codes.to_vec();
    sorted.sort_unstable();
    let mut out: Vec<Segment> = Vec::new();
    for (code, gid) in sorted {
        if let Some(last) = out.last_mut() {
            if code == last.end + 1 && (gid as i64) == (last.delta as i64 + code as i64) {
                last.end = code;
                continue;
            }
        }
        out.push(Segment {
            start: code,
            end: code,
            delta: (gid as i64 - code as i64) as i16,
        });
    }
    out
}

fn cmap_format4(codes: &[(u32, u32)]) -> Vec<u8> {
    let segs = segments(codes);
    let seg_count = segs.len() + 1; // the required 0xFFFF terminator
    let mut out = Vec::new();
    u16be(&mut out, 4);
    u16be(&mut out, (16 + 8 * seg_count) as u16); // length
    u16be(&mut out, 0); // language
    u16be(&mut out, (seg_count * 2) as u16);
    let power = (seg_count as f32).log2().floor() as u32;
    u16be(&mut out, (2 * (1 << power)) as u16); // searchRange
    u16be(&mut out, power as u16); // entrySelector
    u16be(&mut out, (seg_count * 2 - 2 * (1 << power)) as u16); // rangeShift
    for s in &segs {
        u16be(&mut out, s.end as u16);
    }
    u16be(&mut out, 0xffff);
    u16be(&mut out, 0); // reservedPad
    for s in &segs {
        u16be(&mut out, s.start as u16);
    }
    u16be(&mut out, 0xffff);
    for s in &segs {
        i16be(&mut out, s.delta);
    }
    i16be(&mut out, 1); // 0xFFFF maps to glyph 0
    for _ in 0..seg_count {
        u16be(&mut out, 0); // idRangeOffset
    }
    out
}

fn cmap_format12(codes: &[(u32, u32)]) -> Vec<u8> {
    let mut sorted: Vec<(u32, u32)> = codes.to_vec();
    sorted.sort_unstable();
    let mut groups: Vec<(u32, u32, u32)> = Vec::new();
    for (code, gid) in sorted {
        if let Some(last) = groups.last_mut() {
            if code == last.1 + 1 && gid == last.2 + (code - last.0) {
                last.1 = code;
                continue;
            }
        }
        groups.push((code, code, gid));
    }
    let mut out = Vec::new();
    u16be(&mut out, 12);
    u16be(&mut out, 0);
    u32be(&mut out, (16 + 12 * groups.len()) as u32);
    u32be(&mut out, 0); // language
    u32be(&mut out, groups.len() as u32);
    for (start, end, gid) in groups {
        u32be(&mut out, start);
        u32be(&mut out, end);
        u32be(&mut out, gid);
    }
    out
}

/// A `cmap` with a format 4 subtable for the BMP, and a format 12 one when the
/// font reaches past it.
///
/// A format 4 subtable is 16 bits wide, so an astral code is silently dropped by
/// it - a glyph the text names and the font cannot reach, which a browser then
/// draws from a fallback face. Format 12 is what says the whole truth, and a
/// browser that understands it prefers it.
fn cmap_table(codes: &[(u32, u32)]) -> Vec<u8> {
    let bmp: Vec<(u32, u32)> = codes.iter().copied().filter(|(c, _)| *c <= 0xffff).collect();
    let wide: Vec<(u32, u32)> = codes.iter().copied().filter(|(c, _)| *c > 0xffff).collect();
    let four = cmap_format4(&bmp);
    let four_pad = four.len() % 2;
    let twelve = if wide.is_empty() {
        Vec::new()
    } else {
        cmap_format12(codes)
    };

    let count = if twelve.is_empty() { 1usize } else { 2 };
    let header = 4 + 8 * count;
    let four_at = header;
    let twelve_at = four_at + four.len() + four_pad;

    let mut out = Vec::new();
    u16be(&mut out, 0); // version
    u16be(&mut out, count as u16);
    u16be(&mut out, 3); // platform: Windows
    u16be(&mut out, 1); // encoding: Unicode BMP
    u32be(&mut out, four_at as u32);
    if count == 2 {
        u16be(&mut out, 3);
        u16be(&mut out, 10); // encoding: Unicode full repertoire
        u32be(&mut out, twelve_at as u32);
    }
    out.extend_from_slice(&four);
    out.extend_from_slice(&vec![0u8; four_pad]);
    out.extend_from_slice(&twelve);
    out
}

/* ------------------------------------------------------------------ */
/* GSUB: the ligature rules                                            */

/// A list with a two-byte count and two-byte offsets, which is the shape every
/// `GSUB` list has.
fn offset_list(children: &[(Vec<u8>, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    u16be(&mut out, children.len() as u16);
    let base = 2 + 8 * children.len(); // tag(4) + offset(2), kept even
    let mut at = base;
    for (tag, child) in children {
        out.extend_from_slice(tag);
        // Offsets are even, so a child of odd length is padded.
        u16be(&mut out, at as u16);
        at += child.len() + (child.len() % 2);
    }
    for (_, child) in children {
        out.extend_from_slice(child);
        if child.len() % 2 == 1 {
            out.push(0);
        }
    }
    out
}

/// A LangSys naming feature 0 as required-optional, which is the one shape a
/// script needs when the font has exactly one feature.
fn lang_sys() -> Vec<u8> {
    let mut out = Vec::new();
    u16be(&mut out, 0); // lookupOrder
    u16be(&mut out, 0xffff); // requiredFeatureIndex: none
    u16be(&mut out, 1); // featureIndexCount
    u16be(&mut out, 0);
    out
}

/// The `GSUB` table carrying one `liga` feature, or an empty table when there is
/// nothing to substitute.
fn gsub_table(ligatures: &[(u32, Vec<u32>)]) -> Vec<u8> {
    // ligatures: (first glyph, [rest of the glyphs]) with the output first.
    let mut firsts: Vec<u32> = ligatures.iter().map(|(f, _)| *f).collect();
    firsts.sort_unstable();
    firsts.dedup();

    // LigatureSet per first glyph, then the coverage listing them.
    let mut sets: Vec<Vec<u8>> = Vec::new();
    for first in &firsts {
        let mut rules: Vec<(u32, Vec<u32>)> = ligatures
            .iter()
            .filter(|(f, _)| f == first)
            .map(|(_f, r)| {
                // The rule carries the glyph to draw first, then the components
                // after the first - the first is what the coverage matched.
                let mut rest = r.clone();
                let by = rest.remove(0);
                (by, rest)
            })
            .collect();
        // Longest first: a shaper stops at the first rule that matches, and a
        // three-letter ligature shares its first two letters with a two-letter
        // one.
        rules.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then(a.0.cmp(&b.0)));
        rules.dedup();

        let mut set = Vec::new();
        u16be(&mut set, rules.len() as u16);
        let base = 2 + 2 * rules.len();
        let mut at = base;
        for (_, rest) in &rules {
            u16be(&mut set, at as u16);
            at += 4 + 2 * rest.len();
        }
        for (by, rest) in &rules {
            u16be(&mut set, *by as u16);
            u16be(&mut set, (rest.len() + 1) as u16); // component count
            for g in rest {
                u16be(&mut set, *g as u16);
            }
        }
        sets.push(set);
    }

    let mut coverage = Vec::new();
    u16be(&mut coverage, 1);
    u16be(&mut coverage, firsts.len() as u16);
    for g in &firsts {
        u16be(&mut coverage, *g as u16);
    }
    if coverage.len() % 2 == 1 {
        coverage.push(0);
    }

    let mut subtable = Vec::new();
    u16be(&mut subtable, 1); // substFormat
    u16be(&mut subtable, 0); // coverage offset, patched below
    u16be(&mut subtable, sets.len() as u16);
    let base = 6 + 2 * sets.len();
    let mut at = base;
    for set in &sets {
        u16be(&mut subtable, at as u16);
        at += set.len();
    }
    let coverage_at = at;
    for set in &sets {
        subtable.extend_from_slice(set);
    }
    subtable.extend_from_slice(&coverage);
    subtable[2..4].copy_from_slice(&(coverage_at as u16).to_be_bytes());

    let mut lookup = Vec::new();
    u16be(&mut lookup, 4); // lookupType: ligature substitution
    u16be(&mut lookup, 0); // lookupFlag
    u16be(&mut lookup, 1); // subTableCount
    u16be(&mut lookup, 6); // subtable offset, from the start of the lookup
    lookup.extend_from_slice(&subtable);

    let lookup_list = {
        let mut out = Vec::new();
        u16be(&mut out, 1);
        u16be(&mut out, 4); // offset to the lookup, past the two-byte list header
        out.extend_from_slice(&lookup);
        out
    };
    let feature = {
        let mut out = Vec::new();
        u16be(&mut out, 0); // featureParams
        u16be(&mut out, 1); // lookupIndexCount
        u16be(&mut out, 0);
        out
    };
    let feature_list = offset_list(&[(b"liga".to_vec(), feature)]);
    let script = {
        let mut out = Vec::new();
        u16be(&mut out, 4); // defaultLangSys offset
        u16be(&mut out, 0); // langSysCount
        out.extend_from_slice(&lang_sys());
        out
    };
    // Both scripts point at the one LangSys: a browser shaping Latin must not
    // have to reach the default script to find the rule, and one that only
    // reaches the default must still find it.
    let script = std::rc::Rc::new(script);
    let script_list = offset_list(&[
        (b"DFLT".to_vec(), (*script).clone()),
        (b"latn".to_vec(), (*script).clone()),
    ]);

    let mut out = Vec::new();
    u32be(&mut out, 0x0001_0000);
    let header = 10;
    u16be(&mut out, (header) as u16);
    u16be(&mut out, (header + script_list.len()) as u16);
    u16be(
        &mut out,
        (header + script_list.len() + feature_list.len()) as u16,
    );
    out.extend_from_slice(&script_list);
    out.extend_from_slice(&feature_list);
    out.extend_from_slice(&lookup_list);
    out
}

/* ------------------------------------------------------------------ */
/* the other required tables                                           */

fn head_table(upem: u16, bbox: [i16; 4]) -> Vec<u8> {
    let mut out = Vec::new();
    u32be(&mut out, 0x0001_0000); // version
    u32be(&mut out, 0x0001_0000); // fontRevision
    u32be(&mut out, 0); // checkSumAdjustment, patched in `assemble`
    u32be(&mut out, 0x5f0f_3cf5); // magicNumber
    u16be(&mut out, 0x000b); // flags
    u16be(&mut out, upem);
    // A fixed date, so the same input always compiles to the same bytes.
    out.extend_from_slice(&3_821_088u64.to_be_bytes()); // created: 2020-01-01
    out.extend_from_slice(&3_821_088u64.to_be_bytes()); // modified
    i16be(&mut out, bbox[0]);
    i16be(&mut out, bbox[1]);
    i16be(&mut out, bbox[2]);
    i16be(&mut out, bbox[3]);
    u16be(&mut out, 0); // macStyle
    u16be(&mut out, 8); // lowestRecPPEM
    i16be(&mut out, 2); // fontDirectionHint
    i16be(&mut out, 0); // indexToLocFormat
    i16be(&mut out, 0); // glyphDataFormat
    out
}

fn hhea_table(ascender: i16, descender: i16, advance_max: u16, count: u16, bbox: [i16; 4]) -> Vec<u8> {
    let mut out = Vec::new();
    u32be(&mut out, 0x0001_0000);
    i16be(&mut out, ascender);
    i16be(&mut out, descender);
    i16be(&mut out, 0); // lineGap
    u16be(&mut out, advance_max);
    i16be(&mut out, bbox[0]); // minLeftSideBearing
    i16be(&mut out, 0); // minRightSideBearing
    i16be(&mut out, bbox[2]); // xMaxExtent
    i16be(&mut out, 1); // caretSlopeRise
    i16be(&mut out, 0); // caretSlopeRun
    i16be(&mut out, 0); // caretOffset
    for _ in 0..4 {
        i16be(&mut out, 0);
    }
    i16be(&mut out, 0); // metricDataFormat
    u16be(&mut out, count); // numberOfHMetrics
    out
}

fn maxp_table(count: u16) -> Vec<u8> {
    let mut out = Vec::new();
    u32be(&mut out, 0x0000_5000); // version 0.5: a CFF font has no `glyf`
    u16be(&mut out, count);
    out
}

#[allow(clippy::too_many_arguments)]
fn os2_table(
    upem: f32,
    ascender: i16,
    descender: i16,
    first: u16,
    last: u16,
    avg: i16,
) -> Vec<u8> {
    let mut out = Vec::new();
    u16be(&mut out, 4); // version
    i16be(&mut out, avg); // xAvgCharWidth
    u16be(&mut out, 400); // usWeightClass
    u16be(&mut out, 5); // usWidthClass
    u16be(&mut out, 0); // fsType: installable
    for v in [
        (upem * 0.65) as i16, // ySubscriptXSize
        (upem * 0.60) as i16, // ySubscriptYSize
        0,                    // ySubscriptXOffset
        (upem * 0.075) as i16, // ySubscriptYOffset
        (upem * 0.65) as i16, // ySuperscriptXSize
        (upem * 0.60) as i16, // ySuperscriptYSize
        0,                    // ySuperscriptXOffset
        (upem * 0.35) as i16, // ySuperscriptYOffset
        (upem * 0.05) as i16, // yStrikeoutSize
        (upem * 0.25) as i16, // yStrikeoutPosition
    ] {
        i16be(&mut out, v);
    }
    i16be(&mut out, 0); // sFamilyClass
    out.extend_from_slice(&[2, 0, 5, 3, 0, 0, 0, 0, 0, 0]); // panose
    u32be(&mut out, 1); // ulUnicodeRange1: Basic Latin
    u32be(&mut out, 0);
    u32be(&mut out, 0);
    u32be(&mut out, 0);
    out.extend_from_slice(b"wpdf"); // achVendID
    u16be(&mut out, 0x0040); // fsSelection: regular
    u16be(&mut out, first);
    u16be(&mut out, last);
    i16be(&mut out, ascender);
    i16be(&mut out, descender);
    i16be(&mut out, 0); // sTypoLineGap
    u16be(&mut out, ascender.max(0) as u16); // usWinAscent
    u16be(&mut out, (-descender).max(0) as u16); // usWinDescent
    u32be(&mut out, 1); // ulCodePageRange1: Latin 1
    u32be(&mut out, 0);
    i16be(&mut out, (upem * 0.5) as i16); // sxHeight
    i16be(&mut out, (upem * 0.7) as i16); // sCapHeight
    u16be(&mut out, 0); // usDefaultChar
    u16be(&mut out, 0x20); // usBreakChar
    u16be(&mut out, 0); // usMaxContext
    out
}

fn name_table(family: &str, full: &str) -> Vec<u8> {
    let records: [(u16, String); 4] = [
        (1, family.to_owned()),
        (4, full.to_owned()),
        (6, family.to_owned()),
        (2, "Regular".to_owned()),
    ];
    let mut strings = Vec::new();
    let mut recs = Vec::new();
    for (id, text) in &records {
        let at = strings.len();
        for unit in text.encode_utf16() {
            u16be(&mut strings, unit);
        }
        recs.push((*id, at, strings.len() - at));
    }
    let mut out = Vec::new();
    u16be(&mut out, 0); // format
    u16be(&mut out, recs.len() as u16);
    u16be(&mut out, 6 + 12 * recs.len() as u16);
    for (id, at, len) in &recs {
        u16be(&mut out, 3); // platform: Windows
        u16be(&mut out, 1); // encoding: UCS-2
        u16be(&mut out, 0x0409); // language: en-US
        u16be(&mut out, *id);
        u16be(&mut out, *len as u16);
        u16be(&mut out, *at as u16);
    }
    out.extend_from_slice(&strings);
    out
}

fn post_table() -> Vec<u8> {
    let mut out = Vec::new();
    u32be(&mut out, 0x0003_0000); // version 3.0: no glyph names
    u32be(&mut out, 0); // italicAngle
    i16be(&mut out, -75); // underlinePosition
    i16be(&mut out, 50); // underlineThickness
    u32be(&mut out, 0); // isFixedPitch
    u32be(&mut out, 0);
    u32be(&mut out, 0);
    u32be(&mut out, 0);
    u32be(&mut out, 0);
    out
}

/* ------------------------------------------------------------------ */
/* the sfnt container                                                  */

fn checksum(data: &[u8]) -> u32 {
    let mut sum = 0u32;
    let mut at = 0;
    while at + 4 <= data.len() {
        sum = sum.wrapping_add(u32::from_be_bytes([
            data[at],
            data[at + 1],
            data[at + 2],
            data[at + 3],
        ]));
        at += 4;
    }
    if at < data.len() {
        let mut last = [0u8; 4];
        last[..data.len() - at].copy_from_slice(&data[at..]);
        sum = sum.wrapping_add(u32::from_be_bytes(last));
    }
    sum
}

fn assemble(mut tables: Vec<([u8; 4], Vec<u8>)>) -> Vec<u8> {
    tables.sort_by(|a, b| a.0.cmp(&b.0));
    let count = tables.len() as u16;
    let power = (count as f32).log2().floor() as u32;
    let search_range = (16 * (1 << power)) as u16;
    let entry_selector = power as u16;
    let range_shift = 16 * count - search_range;

    let mut out = Vec::new();
    u32be(&mut out, 0x0001_0000); // sfnt version: OTTO
    u16be(&mut out, count);
    u16be(&mut out, search_range);
    u16be(&mut out, entry_selector);
    u16be(&mut out, range_shift);

    let mut at = 12 + 16 * count as usize;
    let mut records = Vec::new();
    for (tag, data) in &tables {
        let sum = if tag == b"head" {
            // The specification computes `head`'s checksum as though its
            // checkSumAdjustment were zero, which is how it is written here.
            checksum(data)
        } else {
            checksum(data)
        };
        records.push((*tag, sum, at as u32, data.len() as u32));
        at += data.len() + (4 - data.len() % 4) % 4;
    }
    let head_at = records
        .iter()
        .find(|(tag, ..)| tag == b"head")
        .map(|(_, _, at, _)| *at as usize)
        .expect("head is always built");

    for (tag, sum, offset, length) in &records {
        out.extend_from_slice(tag);
        u32be(&mut out, *sum);
        u32be(&mut out, *offset);
        u32be(&mut out, *length);
    }
    for (_, data) in &tables {
        out.extend_from_slice(data);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }

    let adjustment = 0xb1b0_afbau32.wrapping_sub(checksum(&out));
    out[head_at + 8..head_at + 12].copy_from_slice(&adjustment.to_be_bytes());
    out
}

/* ------------------------------------------------------------------ */

/// Compile outlines into an OpenType font, or `None` when there is nothing to
/// put in one.
///
/// A `CFF ` table rather than a `glyf` one: its charstrings are cubic, so
/// MuPDF's cubics go in as they are and come back out as the same curve, rounded
/// to the 1/1000 em grid. Nothing here approximates anything.
pub fn build_font(
    glyphs: &[OutlineGlyph],
    ligatures: &[Ligature],
    family: &str,
    units_per_em: u32,
) -> Option<BuiltFont> {
    if glyphs.is_empty() {
        return None;
    }
    let upem = units_per_em as f32;

    // Every code spoken for, so the last-resort assignment below cannot hand a
    // glyph a code another glyph already answers to.
    let mut claimed: std::collections::HashSet<u32> = std::collections::HashSet::new();
    for g in glyphs {
        for c in &g.codes {
            if *c > 0 && *c <= 0x10ffff {
                claimed.insert(*c);
            }
        }
    }
    let mut next_pua = PUA_BASE;
    let mut font_glyphs: Vec<FontGlyph<'_>> = Vec::with_capacity(glyphs.len());
    for g in glyphs {
        let mut codes: Vec<u32> = Vec::new();
        for c in &g.codes {
            if *c > 0 && *c <= 0x10ffff && !codes.contains(c) {
                codes.push(*c);
            }
        }
        if codes.is_empty() {
            while next_pua <= PUA_LIMIT && claimed.contains(&next_pua) {
                next_pua += 1;
            }
            // Out of private-use room: the glyph stays in the font with no code
            // at all rather than taking one that already means something else.
            if next_pua <= PUA_LIMIT {
                codes.push(next_pua);
                claimed.insert(next_pua);
                next_pua += 1;
            }
        }
        let bounds = g.bounds();
        let advance_em = match g.advance_em {
            Some(v) if v > 0.0 => v,
            _ => bounds.x1.max(bounds.x0 + 0.02),
        };
        let advance_em = if advance_em > 0.0 { advance_em } else { 0.5 };
        font_glyphs.push(FontGlyph {
            source: g,
            codes,
            advance: (advance_em * upem).round() as i32,
        });
    }

    // Source glyph id -> index in the compiled font, for the ligature rules.
    let index: std::collections::HashMap<u32, u32> = font_glyphs
        .iter()
        .enumerate()
        .map(|(i, g)| (g.source.gid, i as u32 + 1))
        .collect();
    let rules: Vec<(u32, Vec<u32>)> = ligatures
        .iter()
        .filter_map(|l| {
            let by = *index.get(&l.by)?;
            let mut sub = Vec::with_capacity(l.letters.len() + 1);
            sub.push(by);
            for gid in &l.letters {
                sub.push(*index.get(gid)?);
            }
            if sub.len() < 3 {
                return None;
            }
            Some((sub[0], sub))
        })
        .collect();

    let mut codes: Vec<(u32, u32)> = Vec::new();
    for (i, g) in font_glyphs.iter().enumerate() {
        for c in &g.codes {
            codes.push((*c, i as u32 + 1));
        }
    }
    codes.sort_unstable();
    codes.dedup();

    // Metrics
    let mut ascender_em = f32::NEG_INFINITY;
    let mut descender_em = f32::INFINITY;
    let (mut x0, mut y0) = (f32::INFINITY, f32::INFINITY);
    let (mut x1, mut y1) = (f32::NEG_INFINITY, f32::NEG_INFINITY);
    for g in &font_glyphs {
        let b = g.source.bounds();
        if b.y1 > ascender_em {
            ascender_em = b.y1;
        }
        if b.y0 < descender_em {
            descender_em = b.y0;
        }
        if !g.source.cmds.is_empty() {
            x0 = x0.min(b.x0);
            y0 = y0.min(b.y0);
            x1 = x1.max(b.x1);
            y1 = y1.max(b.y1);
        }
    }
    let ascender = if ascender_em.is_finite() {
        (ascender_em.max(0.7) * upem).round() as i16
    } else {
        800
    };
    let descender = if descender_em.is_finite() {
        (descender_em.min(-0.2) * upem).round() as i16
    } else {
        -200
    };
    let bbox = if x0.is_finite() {
        [
            (x0 * upem).floor() as i16,
            (y0 * upem).floor() as i16,
            (x1 * upem).ceil() as i16,
            (y1 * upem).ceil() as i16,
        ]
    } else {
        [0, (descender as i32) as i16, (upem as i32) as i16, ascender]
    };

    let mut hmtx = Vec::new();
    // `.notdef`: blank, half an em wide.
    u16be(&mut hmtx, (upem * 0.5).round() as u16);
    i16be(&mut hmtx, 0);
    let mut advance_max = (upem * 0.5).round() as u16;
    for g in &font_glyphs {
        let advance = g.advance.clamp(0, 0xffff) as u16;
        if advance > advance_max {
            advance_max = advance;
        }
        let lsb = (g.source.bounds().x0 * upem).floor() as i32;
        u16be(&mut hmtx, advance);
        i16be(&mut hmtx, lsb.clamp(-32768, 32767) as i16);
    }

    let count = (font_glyphs.len() + 1) as u16;
    let first = codes.first().map(|(c, _)| *c).unwrap_or(0).min(0xffff) as u16;
    let last = codes.last().map(|(c, _)| *c).unwrap_or(0).min(0xffff) as u16;
    let avg = if font_glyphs.is_empty() {
        0
    } else {
        (font_glyphs.iter().map(|g| g.advance).sum::<i32>() / font_glyphs.len() as i32) as i16
    };
    let full = format!("{family} Regular");

    let mut tables: Vec<([u8; 4], Vec<u8>)> = vec![
        (*b"CFF ", cff_table(&font_glyphs, family, upem)),
        (*b"OS/2", os2_table(upem, ascender, descender, first, last, avg)),
        (*b"cmap", cmap_table(&codes)),
        (
            *b"head",
            head_table(units_per_em as u16, bbox),
        ),
        (
            *b"hhea",
            hhea_table(ascender, descender, advance_max, count, bbox),
        ),
        (*b"hmtx", hmtx),
        (*b"maxp", maxp_table(count)),
        (*b"name", name_table(family, &full)),
        (*b"post", post_table()),
    ];
    if !rules.is_empty() {
        tables.push((*b"GSUB", gsub_table(&rules)));
    }

    Some(BuiltFont {
        data: assemble(tables),
        units_per_em,
        glyph_count: font_glyphs.len() + 1,
    })
}
