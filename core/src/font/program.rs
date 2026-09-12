//! What a PDF's own font dictionaries say about a font.
//!
//! A PDF embeds a font program in four containers - Type 1 (`/FontFile`), a
//! TrueType subset (`/FontFile2`), a bare CFF or a complete OpenType
//! (`/FontFile3`) - and a page's resources are where they are found. The plan
//! wants three things out of the dictionaries:
//!
//!   - the program itself, because a document-wide face is built from the glyphs
//!     a *font* has rather than the ones one page happened to draw;
//!   - `/ToUnicode`, `/Encoding`'s `/Differences` and `/CIDToGIDMap`, because
//!     those are the document's own statement about which *letters* a glyph
//!     stands for - the one thing a glyph id cannot say;
//!   - the names, so a page's `font_N` can be paired with the face that draws it.
//!
//! What is deliberately *not* read here is where the outlines come from: those
//! are drawn by MuPDF through FreeType (`plan.rs`), because drawing a glyph and
//! re-emitting the curve is cheaper and more faithful than interpreting a
//! charstring.

use std::collections::{HashMap, HashSet};

use mupdf::pdf::{PdfObject, PdfPage};

use super::names::{cff_names, type1_names, GlyphNames};

/// Which descriptor key the program was found under.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgramKey {
    FontFile,
    FontFile2,
    FontFile3,
}

impl ProgramKey {
    fn as_str(self) -> &'static str {
        match self {
            ProgramKey::FontFile => "FontFile",
            ProgramKey::FontFile2 => "FontFile2",
            ProgramKey::FontFile3 => "FontFile3",
        }
    }
}

/// An embedded font program, as the document carries it.
#[derive(Clone, Debug)]
pub struct Program {
    /// `/FontName` of the descriptor: `/BaseFont` with its subset prefix left
    /// on, which is also what MuPDF reports from `Font::name`.
    pub name: String,
    pub key: ProgramKey,
    pub bytes: Vec<u8>,
}

/// An identity for a program that two pages of the same document agree on.
///
/// Content-addressed, because that is what a family name has to be: two subsets
/// are the same font exactly when their bytes are, and the subset prefix a
/// producer chose is not evidence either way.
pub fn program_id(program: &Program) -> String {
    let mut hash: u32 = 0x811c9dc5;
    for byte in &program.bytes {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    format!(
        "{}|{}|{:x}",
        program.key.as_str(),
        program.bytes.len(),
        hash
    )
}

/* ------------------------------------------------------------------ */
/* walking a page's resources                                          */

fn get(obj: &PdfObject, key: &str) -> Option<PdfObject> {
    obj.get_dict(key).ok().flatten().filter(|o| !is_null(o))
}

fn is_null(obj: &PdfObject) -> bool {
    obj.is_null().unwrap_or(true)
}

fn as_name(obj: &PdfObject) -> String {
    obj.as_name()
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

/// Every font program reachable from a page, keyed by the name MuPDF reports for
/// the font.
///
/// A font resource can be a Type 0 font whose descendant carries the descriptor,
/// which is the usual shape for a CID font, so both are followed. The first
/// program found under a name wins: that is the one FreeType would read.
pub fn programs_on_page(page: &PdfPage) -> HashMap<String, Program> {
    let mut out = HashMap::new();
    for font in font_objects(page) {
        let Some(base) = get(&font, "BaseFont").map(|o| as_name(&o)) else {
            continue;
        };
        let Some(dictionary) = Dictionary::of(&font) else {
            continue;
        };
        let Some(program) = dictionary.program() else {
            continue;
        };
        if program.name.is_empty() {
            continue;
        }
        out.entry(program.name.clone()).or_insert(program);
        // A PDF that names `/FontName` differently from `/BaseFont` - which
        // happens with a subset - would otherwise have a font no page could be
        // paired with, so the base name is offered as well.
        if !base.is_empty() && !out.contains_key(&base) {
            out.insert(base, dictionary.program().expect("just read one"));
        }
    }
    out
}

/// Every font dictionary a page can reach, following Form XObjects.
///
/// A form can name the same resource dictionary twice, and a cycle would walk
/// forever; an indirect object seen once is enough.
pub fn font_objects(page: &PdfPage) -> Vec<PdfObject> {
    let mut out = Vec::new();
    let mut visited: HashSet<i32> = HashSet::new();
    let resources = page
        .object()
        .get_dict_inheritable("Resources")
        .ok()
        .flatten();
    scan_resources(&resources, 0, &mut visited, &mut out);
    out
}

fn scan_resources(
    resources: &Option<PdfObject>,
    depth: usize,
    visited: &mut HashSet<i32>,
    out: &mut Vec<PdfObject>,
) {
    let Some(resources) = resources else { return };
    if is_null(resources) || depth > 6 {
        return;
    }
    if resources.is_indirect().unwrap_or(false) {
        if let Ok(id) = resources.as_indirect() {
            if !visited.insert(id) {
                return;
            }
        }
    }
    if let Some(fonts) = get(resources, "Font") {
        if let Ok(iter) = fonts.dict_iter() {
            for entry in iter.flatten() {
                out.push(entry.1);
            }
        }
    }
    if let Some(xobjects) = get(resources, "XObject") {
        if let Ok(iter) = xobjects.dict_iter() {
            for entry in iter.flatten() {
                let xobject = entry.1;
                let subtype = get(&xobject, "Subtype").map(|o| as_name(&o)).unwrap_or_default();
                if subtype == "Form" {
                    let inner = get(&xobject, "Resources");
                    scan_resources(&inner, depth + 1, visited, out);
                }
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* /ToUnicode                                                          */

/// How many mappings a `/ToUnicode` may contribute, and how wide one `bfrange`
/// may be. A page's text is bounded by its characters; anything past this is a
/// misread CMap, and reading it as text would cost the document its memory
/// rather than its text.
const MAX_CODES: usize = 0x10000;
const MAX_RANGE: i64 = 0xffff;

#[derive(Clone, Debug, PartialEq)]
enum Token {
    Hex(String),
    Open,
    Close,
    Word(String),
}

/// The hex operand a token is, when it is one.
fn hex_of(token: &Token) -> Option<&String> {
    match token {
        Token::Hex(value) => Some(value),
        _ => None,
    }
}

/// The tokens of a CMap: hex strings, brackets, and bare words.
fn tokenize(text: &str) -> Vec<Token> {
    let bytes: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut at = 0usize;
    while at < bytes.len() {
        let ch = bytes[at];
        if ch == '%' {
            match text[at..].find('\n') {
                Some(offset) => {
                    // `at` indexes chars, so find the newline among the chars.
                    let mut k = at;
                    while k < bytes.len() && bytes[k] != '\n' {
                        k += 1;
                    }
                    at = k;
                    let _ = offset;
                }
                None => break,
            }
            continue;
        }
        if ch == '(' {
            let mut depth = 0;
            while at < bytes.len() {
                match bytes[at] {
                    '\\' => at += 1,
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            at += 1;
                            break;
                        }
                    }
                    _ => {}
                }
                at += 1;
            }
            continue;
        }
        if ch == '<' {
            let mut end = at;
            while end < bytes.len() && bytes[end] != '>' {
                end += 1;
            }
            if end >= bytes.len() {
                break;
            }
            let value: String = bytes[at + 1..end]
                .iter()
                .filter(|c| c.is_ascii_hexdigit())
                .collect();
            tokens.push(Token::Hex(value));
            at = end + 1;
            continue;
        }
        if ch == '[' {
            tokens.push(Token::Open);
            at += 1;
            continue;
        }
        if ch == ']' {
            tokens.push(Token::Close);
            at += 1;
            continue;
        }
        if ch.is_whitespace() {
            at += 1;
            continue;
        }
        let start = at;
        while at < bytes.len() && !bytes[at].is_whitespace() && !"<>[]()%".contains(bytes[at]) {
            at += 1;
        }
        if at == start {
            at += 1;
            continue;
        }
        tokens.push(Token::Word(bytes[start..at].iter().collect()));
    }
    tokens
}

/// Decode a hex string of UTF-16BE code units into text.
///
/// A `/ToUnicode` destination is a string of UTF-16 code units spelled as four
/// hex digits each, so the digits are read four at a time - a pair of them is a
/// byte, not a character, and reading the first two of `0066` gives `00` rather
/// than `f`. A surrogate pair is two units and one character.
fn utf16be(hex: &str) -> String {
    let digits: Vec<char> = hex.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let unit = |at: usize| -> Option<u32> {
        if at + 4 > digits.len() {
            return None;
        }
        let text: String = digits[at..at + 4].iter().collect();
        u32::from_str_radix(&text, 16).ok()
    };
    let mut text = String::new();
    let mut at = 0usize;
    while let Some(value) = unit(at) {
        at += 4;
        if (0xd800..0xdc00).contains(&value) {
            if let Some(low) = unit(at).filter(|low| (0xdc00..0xe000).contains(low)) {
                at += 4;
                let code = 0x10000 + ((value - 0xd800) << 10) + (low - 0xdc00);
                if let Some(c) = char::from_u32(code) {
                    text.push(c);
                }
                continue;
            }
        }
        if let Some(c) = char::from_u32(value) {
            text.push(c);
        }
    }
    text
}

/// The numeric code a CMap source string stands for: its bytes, big-endian.
fn code_of(hex: &str) -> u32 {
    let mut code: u32 = 0;
    let bytes: Vec<u8> = hex.bytes().collect();
    let mut at = 0usize;
    while at + 2 <= bytes.len() {
        let pair = std::str::from_utf8(&bytes[at..at + 2]).unwrap_or("00");
        code = code.wrapping_mul(256).wrapping_add(
            u32::from_str_radix(pair, 16).unwrap_or(0),
        );
        at += 2;
    }
    code
}

/// Step a destination's last UTF-16 code unit by `offset`, per the CMap spec.
fn step(text: &str, offset: i64) -> String {
    let mut units: Vec<u32> = text.chars().map(|c| c as u32).collect();
    if units.is_empty() {
        return String::new();
    }
    let last = units.len() - 1;
    units[last] = ((units[last] as i64 + offset) & 0xffff) as u32;
    units.iter().filter_map(|u| char::from_u32(*u)).collect()
}

/// The `/ToUnicode` CMap of a font, as code -> characters.
///
/// Only the operators that carry text are read - `bfchar` and `bfrange`, in both
/// its string and its array form - because `codespacerange` and `notdefrange`
/// describe which codes are legal rather than what they mean.
pub fn parse_cmap(text: &str) -> HashMap<u32, String> {
    let tokens = tokenize(text);
    let mut by_code: HashMap<u32, String> = HashMap::new();
    let mut at = 0usize;
    while at < tokens.len() {
        let word = match &tokens[at] {
            Token::Word(w) => w.clone(),
            _ => {
                at += 1;
                continue;
            }
        };
        if word == "beginbfchar" {
            at += 1;
            while at < tokens.len() {
                if matches!(tokens[at], Token::Word(_)) {
                    break;
                }
                let Some(source) = hex_of(&tokens[at]) else {
                    at += 1;
                    continue;
                };
                let Some(destination) = tokens.get(at + 1).and_then(hex_of) else {
                    at += 1;
                    continue;
                };
                by_code.insert(code_of(source), utf16be(destination));
                at += 2;
            }
            continue;
        }
        if word == "beginbfrange" {
            at += 1;
            while at < tokens.len() {
                if matches!(tokens[at], Token::Word(_)) {
                    break;
                }
                let Some(low) = hex_of(&tokens[at]) else {
                    at += 1;
                    continue;
                };
                let Some(high) = tokens.get(at + 1).and_then(hex_of) else {
                    at += 1;
                    continue;
                };
                let from = code_of(low);
                let to = code_of(high);
                at += 2;
                if matches!(tokens.get(at), Some(Token::Open)) {
                    at += 1;
                    let mut index = 0i64;
                    while at < tokens.len() && !matches!(tokens[at], Token::Close) {
                        if let Some(item) = hex_of(&tokens[at]) {
                            if (from as i64 + index) <= to as i64 && by_code.len() < MAX_CODES {
                                by_code.insert((from as i64 + index) as u32, utf16be(item));
                            }
                        }
                        index += 1;
                        at += 1;
                    }
                    at += 1;
                    continue;
                }
                let Some(destination) = tokens.get(at).and_then(hex_of) else {
                    continue;
                };
                // A range this wide is a codespace, not a text mapping: a
                // `bfrange` that spells out a run of characters is a few hundred
                // codes at the very most, and one that says `0..0xffffffff` is a
                // misread.
                if (to as i64) < from as i64 || (to as i64 - from as i64) > MAX_RANGE {
                    at += 1;
                    continue;
                }
                let base = utf16be(destination);
                let mut code = from as i64;
                while code <= to as i64 && by_code.len() < MAX_CODES {
                    let offset = code - from as i64;
                    by_code.insert(
                        code as u32,
                        if offset == 0 {
                            base.clone()
                        } else {
                            step(&base, offset)
                        },
                    );
                    code += 1;
                }
                at += 1;
            }
            continue;
        }
        at += 1;
    }
    by_code
}

fn read_to_unicode(stream: &PdfObject) -> Option<HashMap<u32, String>> {
    if !stream.is_stream().ok()? {
        return None;
    }
    let bytes = stream.read_stream().ok()?;
    Some(parse_cmap(&String::from_utf8_lossy(&bytes)))
}

/* ------------------------------------------------------------------ */
/* the font dictionary                                                 */

struct Dictionary {
    /// `/DescendantFonts[0]` for a Type 0 font, the font itself otherwise.
    descendant: PdfObject,
    /// `/Subtype` of the descendant: which CID mapping applies, if any.
    descendant_type: String,
    is_type0: bool,
    /// The `/Encoding` name of a Type 0 font, when it is one.
    cmap: String,
}

impl Dictionary {
    fn of(font: &PdfObject) -> Option<Self> {
        let subtype = get(font, "Subtype").map(|o| as_name(&o)).unwrap_or_default();
        let is_type0 = subtype.contains("Type0");
        if !is_type0 {
            return Some(Self {
                descendant: font.clone(),
                descendant_type: subtype,
                is_type0,
                cmap: String::new(),
            });
        }
        let mut cmap = String::new();
        if let Some(encoding) = get(font, "Encoding") {
            if encoding.is_name().unwrap_or(false) {
                cmap = as_name(&encoding);
            }
        }
        let mut descendant = font.clone();
        if let Some(descendants) = get(font, "DescendantFonts") {
            if let Ok(Some(first)) = descendants.get_array(0) {
                descendant = first;
            }
        }
        let descendant_type = get(&descendant, "Subtype")
            .map(|o| as_name(&o))
            .unwrap_or_default();
        Some(Self {
            descendant,
            descendant_type,
            is_type0,
            cmap,
        })
    }

    /// The embedded program behind this font dictionary, if it has one.
    fn program(&self) -> Option<Program> {
        let descriptor = get(&self.descendant, "FontDescriptor")?;
        let mut name = get(&descriptor, "FontName")
            .map(|o| as_name(&o))
            .unwrap_or_default();
        if name.is_empty() {
            name = String::new();
        }
        for key in [
            ProgramKey::FontFile,
            ProgramKey::FontFile2,
            ProgramKey::FontFile3,
        ] {
            if let Some(reference) = get(&descriptor, key.as_str()) {
                if let Ok(bytes) = reference.read_stream() {
                    return Some(Program { name, key, bytes });
                }
            }
        }
        None
    }

    /// gid -> glyph name and the font's own encoding, from whichever container.
    fn names(&self, program: Option<&Program>) -> Option<GlyphNames> {
        let program = program?;
        match program.key {
            ProgramKey::FontFile => type1_names(&program.bytes),
            ProgramKey::FontFile3 => cff_names(&program.bytes),
            // A TrueType `post` table this does not read, and a `cmap` that says
            // nothing about glyph *names*: a glyph this font names is not named
            // here, which costs a ligature and never a wrong glyph.
            ProgramKey::FontFile2 => None,
        }
    }
}

/// The letters a ligature glyph stands for, by name.
///
/// `fi` is not a name *for* the ligature, it *is* the two letters, so a font
/// dictionary that names a glyph `fi` has already said what its text should say.
pub fn ligature_name(name: &str) -> bool {
    matches!(name, "ff" | "fi" | "fl" | "ffi" | "ffl" | "st" | "\u{17f}t")
}

/// The letters each ligature character stands for, by code point: the other
/// direction of the table above, for the reader that has the character in hand.
pub fn ligature_letters(code: u32) -> Option<&'static str> {
    Some(match code {
        0xfb00 => "ff",
        0xfb01 => "fi",
        0xfb02 => "fl",
        0xfb03 => "ffi",
        0xfb04 => "ffl",
        0xfb05 => "\u{17f}t",
        0xfb06 => "st",
        _ => return None,
    })
}

/// The `/Encoding` of a simple font as code -> glyph name.
///
/// Only `/Differences` is read: those are the document's own statement about a
/// code, and a ligature is exactly the sort of glyph a producer puts there. A
/// code left to the base encoding is resolved from the *program's* own encoding
/// instead, which is the same answer for every base encoding the corpus uses and
/// needs no table of 256 names per encoding to carry around.
fn differences_of(font: &PdfObject) -> Option<Vec<(u32, String)>> {
    let encoding = get(font, "Encoding")?;
    if !encoding.is_dict().unwrap_or(false) {
        return None;
    }
    let differences = get(&encoding, "Differences")?;
    if !differences.is_array().unwrap_or(false) {
        return None;
    }
    let mut out: Vec<(u32, String)> = Vec::new();
    let mut code: i64 = -1;
    for item in differences.array_iter().ok()?.flatten() {
        if item.is_number().unwrap_or(false) {
            code = item.as_float().unwrap_or(0.0) as i64;
            continue;
        }
        if code < 0 {
            continue;
        }
        let name = as_name(&item);
        if !name.is_empty() {
            out.push((code as u32, name));
        }
        code += 1;
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// The glyph id a Type 0 font's character code reaches, or `None` when that
/// cannot be established.
///
/// `Identity-H` and `Identity-V` are the CMap a subset uses when its ids *are*
/// its CIDs, and the common `/CIDToGIDMap /Identity` then makes the code the
/// glyph id. A distinct CMap (`UniJIS-UCS2-H` and friends) renumbers the code
/// before the CID, and this does not carry those tables - nor, for a
/// `CIDFontType0`, the CFF's own charset - so it answers `None` rather than
/// guessing, which costs a ligature and never a wrong glyph.
fn cid_to_gid(
    dictionary: &Dictionary,
    code: u32,
    map: Option<&PdfObject>,
    bytes: Option<&[u8]>,
) -> Option<u32> {
    if !dictionary.is_type0 {
        return None;
    }
    if !dictionary.cmap.contains("Identity") {
        return None;
    }
    if dictionary.descendant_type.contains("CIDFontType0") {
        return None;
    }
    let Some(map) = map.filter(|m| !is_null(m)) else {
        return Some(code);
    };
    if map.is_name().unwrap_or(false) {
        return Some(code);
    }
    if !map.is_stream().unwrap_or(false) {
        return None;
    }
    let bytes = bytes?;
    let at = code as usize * 2;
    if at + 1 >= bytes.len() {
        return None;
    }
    let gid = ((bytes[at] as u32) << 8) | bytes[at + 1] as u32;
    if gid > 0 {
        Some(gid)
    } else {
        None
    }
}

/// What the dictionaries on one page say about one font.
#[derive(Clone, Debug, Default)]
pub struct FontEncoding {
    /// `/BaseFont`, subset prefix and all: the key the walk knows the font by.
    pub name: String,
    /// gid -> the letters a ligature glyph stands for, where the document says.
    pub letters: HashMap<u32, String>,
}

/// Read the letters every font on a page names, by `/BaseFont`.
///
/// `programs` is the same map the walk built its fonts from, so a dictionary is
/// only asked about glyph ids when the plan actually has that program in hand: a
/// font the page draws through a substituted face has no ids this could speak
/// about, and reading another font's names into them would be worse than saying
/// nothing.
///
/// `cache` belongs to the caller and is keyed by the font resource's indirect
/// object, so a document that draws one font on a thousand pages parses it once.
pub fn page_encodings(
    page: &PdfPage,
    programs: &HashMap<String, Program>,
    cache: &mut HashMap<i32, FontEncoding>,
) -> HashMap<String, FontEncoding> {
    let mut out = HashMap::new();
    for font in font_objects(page) {
        let base = get(&font, "BaseFont")
            .map(|o| as_name(&o))
            .unwrap_or_default();
        if base.is_empty() {
            continue;
        }
        let key = if font.is_indirect().unwrap_or(false) {
            font.as_indirect().unwrap_or(0)
        } else {
            -(out.len() as i32) - 1
        };
        let encoding = match cache.get(&key) {
            Some(hit) => hit.clone(),
            None => {
                let known = programs.get(&base);
                let read = read_font_encoding(&font, known);
                cache.insert(key, read.clone());
                read
            }
        };
        out.entry(encoding.name.clone()).or_insert(encoding);
    }
    out
}

/// One font dictionary, read for the letters it names.
fn read_font_encoding(font: &PdfObject, known: Option<&Program>) -> FontEncoding {
    let name = get(font, "BaseFont")
        .map(|o| as_name(&o))
        .unwrap_or_default();
    let mut letters: HashMap<u32, String> = HashMap::new();
    let Some(dictionary) = Dictionary::of(font) else {
        return FontEncoding { name, letters };
    };
    // The walk's own program is the authority on glyph ids; a program read out of
    // this dictionary is used when the walk has none, which is the case for a
    // font that lives in a Form XObject's resources and nowhere else.
    let owned;
    let program = match known {
        Some(p) => Some(p),
        None => {
            owned = dictionary.program();
            owned.as_ref()
        }
    };
    let Some(glyphs) = dictionary.names(program) else {
        return FontEncoding { name, letters };
    };

    let mut names_to_gid: HashMap<&str, u32> = HashMap::new();
    for (gid, glyph) in glyphs.names.iter().enumerate() {
        if !glyph.is_empty() {
            names_to_gid.entry(glyph.as_str()).or_insert(gid as u32);
        }
    }

    // A Type 0 font's codes are CIDs, not a simple encoding's character codes, so
    // the program's own encoding says nothing about them.
    let encoding: Vec<(u32, String)> = if dictionary.is_type0 {
        Vec::new()
    } else {
        differences_of(font).unwrap_or_else(|| glyphs.encoding.clone())
    };
    for (_, glyph) in &encoding {
        if !ligature_name(glyph) {
            continue;
        }
        if let Some(gid) = names_to_gid.get(glyph.as_str()) {
            letters.insert(*gid, glyph.clone());
        }
    }

    // A `/ToUnicode` entry longer than one character is the document saying what
    // it reads the code as, which is the letters of a ligature written the other
    // way round. It wins over a name where the two disagree.
    if let Some(stream) = get(font, "ToUnicode") {
        if let Some(to_unicode) = read_to_unicode(&stream) {
            let map = get(&dictionary.descendant, "CIDToGIDMap");
            let map_bytes = map
                .as_ref()
                .filter(|m| m.is_stream().unwrap_or(false))
                .and_then(|m| m.read_stream().ok());
            let by_code: HashMap<u32, &str> = encoding
                .iter()
                .map(|(code, name)| (*code, name.as_str()))
                .collect();
            // Sorted, so a page's letters do not depend on a hash map's order.
            let mut entries: Vec<(u32, String)> = to_unicode.into_iter().collect();
            entries.sort_by_key(|(code, _)| *code);
            for (code, text) in entries {
                if text.chars().count() < 2 {
                    continue;
                }
                let gid = cid_to_gid(&dictionary, code, map.as_ref(), map_bytes.as_deref())
                    .or_else(|| {
                        by_code
                            .get(&code)
                            .and_then(|name| names_to_gid.get(name).copied())
                    });
                match gid {
                    Some(gid) if gid > 0 => {
                        letters.insert(gid, text);
                    }
                    _ => {}
                }
            }
        }
    }

    FontEncoding { name, letters }
}
