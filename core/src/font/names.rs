//! Glyph names out of an embedded font program.
//!
//! A font *program* knows its glyphs; a PDF's dictionary knows what the document
//! calls them. The plan needs one thing out of the two of them: for a glyph the
//! page drew, the *letters* the document writes it as. That is only ever wanted
//! for a ligature - a page draws one glyph for `fi`, and a face whose cmap says
//! that glyph is `U+FB01` copies as one character where the reader searched for
//! two - and in a CFF or a Type 1 the glyph's *name* is where that is written
//! down.
//!
//! Nothing here draws or converts anything: the outlines still come from MuPDF
//! (`Font::outline_glyph`), because drawing a glyph through FreeType and
//! re-emitting the curve is cheaper and more faithful than interpreting a
//! charstring.

/// The glyph names of a program, and the encoding it carries.
#[derive(Clone, Debug, Default)]
pub struct GlyphNames {
    /// gid -> glyph name. `names[0]` is `.notdef`.
    pub names: Vec<String>,
    /// The program's own encoding as code -> glyph name, when it has one.
    pub encoding: Vec<(u32, String)>,
}

/// The 391 strings the CFF specification fixes (Appendix A), in SID order.
///
/// A charset names each glyph with a SID; SIDs below this table's length are one
/// of these strings and everything above it is in the font's own String INDEX.
/// The table has to be complete: `fi` and `fl` are standard strings, and they are
/// exactly the names a ligature is read from - so a reader that only carried the
/// font's own strings would miss the one case this module exists for.
#[rustfmt::skip]
const CFF_STANDARD_STRINGS: &[&str] = &[
    ".notdef", "space", "exclam", "quotedbl", "numbersign", "dollar", "percent", "ampersand",
    "quoteright", "parenleft", "parenright", "asterisk", "plus", "comma", "hyphen", "period",
    "slash", "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "colon", "semicolon", "less", "equal", "greater", "question", "at", "A", "B", "C", "D", "E",
    "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W",
    "X", "Y", "Z", "bracketleft", "backslash", "bracketright", "asciicircum", "underscore",
    "quoteleft", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p",
    "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "braceleft", "bar", "braceright",
    "asciitilde", "exclamdown", "cent", "sterling", "fraction", "yen", "florin", "section",
    "currency", "quotesingle", "quotedblleft", "guillemotleft", "guilsinglleft", "guilsinglright",
    "fi", "fl", "endash", "dagger", "daggerdbl", "periodcentered", "paragraph", "bullet",
    "quotesinglbase", "quotedblbase", "quotedblright", "guillemotright", "ellipsis", "perthousand",
    "questiondown", "grave", "acute", "circumflex", "tilde", "macron", "breve", "dotaccent",
    "dieresis", "ring", "cedilla", "hungarumlaut", "ogonek", "caron", "emdash", "AE", "ordfeminine",
    "Lslash", "Oslash", "OE", "ordmasculine", "ae", "dotlessi", "lslash", "oslash", "oe", "germandbls",
    "onesuperior", "logicalnot", "mu", "trademark", "Eth", "onehalf", "plusminus", "Thorn",
    "onequarter", "divide", "brokenbar", "degree", "thorn", "threequarters", "twosuperior",
    "registered", "minus", "eth", "multiply", "threesuperior", "copyright", "Aacute", "Acircumflex",
    "Adieresis", "Agrave", "Aring", "Atilde", "Ccedilla", "Eacute", "Ecircumflex", "Edieresis",
    "Egrave", "Iacute", "Icircumflex", "Idieresis", "Igrave", "Ntilde", "Oacute", "Ocircumflex",
    "Odieresis", "Ograve", "Otilde", "Scaron", "Uacute", "Ucircumflex", "Udieresis", "Ugrave",
    "Yacute", "Ydieresis", "Zcaron", "aacute", "acircumflex", "adieresis", "agrave", "aring",
    "atilde", "ccedilla", "eacute", "ecircumflex", "edieresis", "egrave", "iacute", "icircumflex",
    "idieresis", "igrave", "ntilde", "oacute", "ocircumflex", "odieresis", "ograve", "otilde",
    "scaron", "uacute", "ucircumflex", "udieresis", "ugrave", "yacute", "ydieresis", "zcaron",
    "exclamsmall", "Hungarumlautsmall", "dollaroldstyle", "dollarsuperior", "ampersandsmall",
    "Acutesmall", "parenleftsuperior", "parenrightsuperior", "twodotenleader", "onedotenleader",
    "zerooldstyle", "oneoldstyle", "twooldstyle", "threeoldstyle", "fouroldstyle", "fiveoldstyle",
    "sixoldstyle", "sevenoldstyle", "eightoldstyle", "nineoldstyle", "commasuperior",
    "threequartersemdash", "periodsuperior", "questionsmall", "asuperior", "bsuperior",
    "centsuperior", "dsuperior", "esuperior", "isuperior", "lsuperior", "msuperior", "nsuperior",
    "osuperior", "rsuperior", "ssuperior", "tsuperior", "ff", "ffi", "ffl", "parenleftinferior",
    "parenrightinferior", "Circumflexsmall", "hyphensuperior", "Gravesmall", "Asmall", "Bsmall",
    "Csmall", "Dsmall", "Esmall", "Fsmall", "Gsmall", "Hsmall", "Ismall", "Jsmall", "Ksmall",
    "Lsmall", "Msmall", "Nsmall", "Osmall", "Psmall", "Qsmall", "Rsmall", "Ssmall", "Tsmall",
    "Usmall", "Vsmall", "Wsmall", "Xsmall", "Ysmall", "Zsmall", "colonmonetary", "onefitted",
    "rupiah", "Tildesmall", "exclamdownsmall", "centoldstyle", "Lslashsmall", "Scaronsmall",
    "Zcaronsmall", "Dieresissmall", "Brevesmall", "Caronsmall", "Dotaccentsmall", "Macronsmall",
    "figuredash", "hypheninferior", "Ogoneksmall", "Ringsmall", "Cedillasmall", "questiondownsmall",
    "oneeighth", "threeeighths", "fiveeighths", "seveneighths", "onethird", "twothirds", "zerosuperior",
    "foursuperior", "fivesuperior", "sixsuperior", "sevensuperior", "eightsuperior", "ninesuperior",
    "zeroinferior", "oneinferior", "twoinferior", "threeinferior", "fourinferior", "fiveinferior",
    "sixinferior", "seveninferior", "eightinferior", "nineinferior", "centinferior",
    "dollarinferior", "periodinferior", "commainferior", "Agravesmall", "Aacutesmall",
    "Acircumflexsmall", "Atildesmall", "Adieresissmall", "Aringsmall", "AEsmall", "Ccedillasmall",
    "Egravesmall", "Eacutesmall", "Ecircumflexsmall", "Edieresissmall", "Igravesmall",
    "Iacutesmall", "Icircumflexsmall", "Idieresissmall", "Ethsmall", "Ntildesmall", "Ogravesmall",
    "Oacutesmall", "Ocircumflexsmall", "Otildesmall", "Odieresissmall", "OEsmall", "Oslashsmall",
    "Ugravesmall", "Uacutesmall", "Ucircumflexsmall", "Udieresissmall", "Yacutesmall",
    "Thornsmall", "Ydieresissmall", "001.000", "001.001", "001.002", "001.003", "Black", "Bold",
    "Book", "Light", "Medium", "Regular", "Roman", "Semibold",
];

/* ------------------------------------------------------------------ */
/* sfnt                                                                */

/// The `CFF ` table of a program: the bytes themselves when they are a bare
/// CFF, or the table inside an OpenType wrapper.
fn cff_table(bytes: &[u8]) -> Option<&[u8]> {
    if bytes.len() > 4 && bytes[0] == 0x01 && bytes[1] == 0x00 {
        return Some(bytes);
    }
    if bytes.len() > 12 && matches!(&bytes[0..4], b"OTTO" | b"true" | b"typ1") {
        let count = u16::from_be_bytes([bytes[4], bytes[5]]) as usize;
        for i in 0..count {
            let at = 12 + i * 16;
            if at + 16 > bytes.len() {
                return None;
            }
            if &bytes[at..at + 4] == b"CFF " {
                let offset = u32::from_be_bytes([
                    bytes[at + 8],
                    bytes[at + 9],
                    bytes[at + 10],
                    bytes[at + 11],
                ]) as usize;
                let length = u32::from_be_bytes([
                    bytes[at + 12],
                    bytes[at + 13],
                    bytes[at + 14],
                    bytes[at + 15],
                ]) as usize;
                return bytes.get(offset..offset + length);
            }
        }
    }
    None
}

/* ------------------------------------------------------------------ */
/* CFF                                                                 */

/// A CFF INDEX: where each item starts and ends, and where the next INDEX is.
fn read_index(bytes: &[u8], at: usize) -> (Vec<(usize, usize)>, usize) {
    if at + 2 > bytes.len() {
        return (Vec::new(), bytes.len());
    }
    let count = u16::from_be_bytes([bytes[at], bytes[at + 1]]) as usize;
    if count == 0 {
        return (Vec::new(), at + 2);
    }
    if at + 3 > bytes.len() {
        return (Vec::new(), bytes.len());
    }
    let off_size = bytes[at + 2] as usize;
    if off_size == 0 || off_size > 4 {
        return (Vec::new(), bytes.len());
    }
    let off_at = at + 3;
    let read_offset = |i: usize| -> usize {
        let mut value = 0usize;
        for k in 0..off_size {
            value = (value << 8) | *bytes.get(off_at + i * off_size + k).unwrap_or(&0) as usize;
        }
        value
    };
    let data_at = off_at + (count + 1) * off_size - 1;
    let mut items = Vec::with_capacity(count);
    for i in 0..count {
        let start = data_at + read_offset(i);
        let end = data_at + read_offset(i + 1);
        if start > end || end > bytes.len() {
            return (items, bytes.len());
        }
        items.push((start, end));
    }
    (items, (data_at + read_offset(count)).min(bytes.len()))
}

/// A CFF DICT, as operator -> the operands on its stack. A later operator
/// replaces an earlier one, which is what the specification says.
fn parse_dict(bytes: &[u8], mut at: usize, end: usize) -> Vec<(u32, Vec<i32>)> {
    let mut ops: Vec<(u32, Vec<i32>)> = Vec::new();
    let mut stack: Vec<i32> = Vec::new();
    while at < end && at < bytes.len() {
        let b0 = bytes[at] as i32;
        at += 1;
        if b0 <= 21 {
            let op = if b0 == 12 {
                let b1 = *bytes.get(at).unwrap_or(&0) as u32;
                at += 1;
                1200 + b1
            } else {
                b0 as u32
            };
            ops.retain(|(o, _)| *o != op);
            ops.push((op, std::mem::take(&mut stack)));
        } else if b0 == 28 {
            if at + 2 > bytes.len() {
                break;
            }
            stack.push(i16::from_be_bytes([bytes[at], bytes[at + 1]]) as i32);
            at += 2;
        } else if b0 == 29 {
            if at + 4 > bytes.len() {
                break;
            }
            stack.push(i32::from_be_bytes([
                bytes[at],
                bytes[at + 1],
                bytes[at + 2],
                bytes[at + 3],
            ]));
            at += 4;
        } else if b0 == 30 {
            let mut text = String::new();
            let mut done = false;
            while !done && at < bytes.len() {
                let b = bytes[at];
                at += 1;
                for nibble in [b >> 4, b & 15] {
                    match nibble {
                        0..=9 => text.push((b'0' + nibble) as char),
                        10 => text.push('.'),
                        11 => text.push('E'),
                        12 => text.push_str("E-"),
                        14 => text.push('-'),
                        _ => {
                            done = true;
                            break;
                        }
                    }
                }
            }
            stack.push(text.parse().unwrap_or(0));
        } else if (32..=246).contains(&b0) {
            stack.push(b0 - 139);
        } else if (247..=250).contains(&b0) {
            let b1 = *bytes.get(at).unwrap_or(&0) as i32;
            at += 1;
            stack.push((b0 - 247) * 256 + b1 + 108);
        } else if (251..=254).contains(&b0) {
            let b1 = *bytes.get(at).unwrap_or(&0) as i32;
            at += 1;
            stack.push(-(b0 - 251) * 256 - b1 - 108);
        } else {
            break;
        }
    }
    ops
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|b| *b as char).collect()
}

fn cff_parts(bytes: &[u8]) -> Option<GlyphNames> {
    let cff = cff_table(bytes)?;
    if cff.len() < 4 {
        return None;
    }
    let mut at = cff[2] as usize;
    at = read_index(cff, at).1; // Name INDEX
    let (top, next) = read_index(cff, at);
    at = next;
    let (strings, _) = read_index(cff, at);
    let item = *top.first()?;
    let dict = parse_dict(cff, item.0, item.1);

    let get = |op: u32| -> Option<i32> {
        dict.iter()
            .rev()
            .find(|(o, _)| *o == op)
            .and_then(|(_, v)| v.first().copied())
    };
    let charset_offset = get(15).unwrap_or(0);
    let encoding_offset = get(16).unwrap_or(0);
    let char_strings = get(17)? as usize;
    let glyphs = read_index(cff, char_strings).0;
    let count = glyphs.len();

    let sid = |value: i32| -> String {
        if value < 0 {
            return String::new();
        }
        let value = value as usize;
        if value < CFF_STANDARD_STRINGS.len() {
            return CFF_STANDARD_STRINGS[value].to_string();
        }
        match strings.get(value - CFF_STANDARD_STRINGS.len()) {
            Some((start, end)) => latin1(&cff[*start..*end]),
            None => String::new(),
        }
    };

    let mut names: Vec<String> = Vec::with_capacity(count);
    names.push(".notdef".to_string());
    if charset_offset == 0 {
        // ISOAdobe: gid n is SID n.
        for gid in 1..count {
            names.push(sid(gid as i32));
        }
    } else if charset_offset == 1 || charset_offset == 2 {
        // The Expert charsets are a fixed table this build does not carry; the
        // names are not what a PDF's ligatures come from, so they are left blank
        // rather than guessed. A blank name resolves nothing, which is safe.
        for _ in 1..count {
            names.push(String::new());
        }
    } else {
        let format = *cff.get(charset_offset as usize).unwrap_or(&0);
        let mut cursor = charset_offset as usize + 1;
        if format == 0 {
            for _ in 1..count {
                let value = ((*cff.get(cursor).unwrap_or(&0) as i32) << 8)
                    | *cff.get(cursor + 1).unwrap_or(&0) as i32;
                names.push(sid(value));
                cursor += 2;
            }
        } else {
            let wide = format == 2;
            let step = if wide { 4 } else { 3 };
            while names.len() < count && cursor + step <= cff.len() {
                let first = ((cff[cursor] as i32) << 8) | cff[cursor + 1] as i32;
                let left = if wide {
                    ((cff[cursor + 2] as i32) << 8) | cff[cursor + 3] as i32
                } else {
                    cff[cursor + 2] as i32
                };
                cursor += step;
                for i in 0..=left {
                    if names.len() >= count {
                        break;
                    }
                    names.push(sid(first + i));
                }
            }
        }
    }

    let mut encoding: Vec<(u32, String)> = Vec::new();
    if encoding_offset > 1 {
        let base = encoding_offset as usize;
        let format = *cff.get(base).unwrap_or(&0);
        let mut cursor = base + 1;
        let n_codes = *cff.get(cursor).unwrap_or(&0) as usize;
        cursor += 1;
        if format & 0x7f == 0 {
            for i in 0..n_codes {
                let code = *cff.get(cursor + i).unwrap_or(&0) as u32;
                let name = names.get(i + 1).cloned().unwrap_or_default();
                encoding.push((code, name));
            }
            cursor += n_codes;
        } else if format & 0x7f == 1 {
            let mut gid = 1usize;
            for _ in 0..n_codes {
                let first = *cff.get(cursor).unwrap_or(&0) as u32;
                let left = *cff.get(cursor + 1).unwrap_or(&0) as u32;
                cursor += 2;
                for k in 0..=left {
                    let name = names.get(gid).cloned().unwrap_or_default();
                    encoding.push((first + k, name));
                    gid += 1;
                }
            }
        }
        if format & 0x80 != 0 {
            let n_sups = *cff.get(cursor).unwrap_or(&0) as usize;
            cursor += 1;
            for _ in 0..n_sups {
                let code = *cff.get(cursor).unwrap_or(&0) as u32;
                let value = ((*cff.get(cursor + 1).unwrap_or(&0) as i32) << 8)
                    | *cff.get(cursor + 2).unwrap_or(&0) as i32;
                cursor += 3;
                let name = sid(value);
                if let Some(gid) = names.iter().position(|n| *n == name) {
                    if gid > 0 {
                        encoding.push((code, name));
                    }
                }
            }
        }
    }

    Some(GlyphNames { names, encoding })
}

/// The glyph names of a CFF program, or `None` when the bytes are not a CFF.
pub fn cff_names(bytes: &[u8]) -> Option<GlyphNames> {
    cff_parts(bytes)
}

/* ------------------------------------------------------------------ */
/* Type 1                                                              */

/// eexec's key, and the charstrings' own. Both from the Type 1 specification.
const EEXEC_KEY: u16 = 55665;
const C1: u32 = 52845;
const C2: u32 = 22719;

fn decrypt(cipher: &[u8], key: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(cipher.len());
    let mut r = key as u32;
    for c in cipher {
        let c = *c as u32;
        out.push((c ^ (r >> 8)) as u8);
        r = ((c + r) * C1 + C2) & 0xffff;
    }
    out
}

/// A PFB is a sequence of segments - `0x80 0x01` ASCII, `0x80 0x02` binary,
/// `0x80 0x03` end - and a PFA is already one flat stream.
fn flatten(bytes: &[u8]) -> Vec<u8> {
    if !(bytes.len() > 1 && bytes[0] == 0x80 && (bytes[1] == 0x01 || bytes[1] == 0x02)) {
        return bytes.to_vec();
    }
    let mut out = Vec::new();
    let mut at = 0usize;
    while at + 6 <= bytes.len() {
        let kind = bytes[at + 1];
        let length =
            u32::from_le_bytes([bytes[at + 2], bytes[at + 3], bytes[at + 4], bytes[at + 5]])
                as usize;
        at += 6;
        if kind == 3 || at + length > bytes.len() {
            break;
        }
        out.extend_from_slice(&bytes[at..at + length]);
        at += length;
    }
    out
}

/// Where the cleartext ends and the encrypted section starts.
fn split_eexec(bytes: &[u8]) -> Option<(usize, usize)> {
    let head = &bytes[..bytes.len().min(0x10000)];
    let text = String::from_utf8_lossy(head).into_owned();
    let raw = text.as_bytes();
    let mut at: Option<usize> = None;
    let mut i = 0;
    while i + 5 <= raw.len() {
        if &raw[i..i + 5] == b"eexec" {
            let before_ok = i == 0
                || matches!(
                    raw[i - 1],
                    b' ' | b'\t' | b'\n' | b'\r' | b')' | b']' | b'}'
                );
            let after_ok = !matches!(
                raw.get(i + 5).copied(),
                Some(c) if c.is_ascii_alphanumeric() || c == b'/'
            );
            if before_ok && after_ok {
                at = Some(i);
            }
        }
        i += 1;
    }
    let at = at?;
    let mut start = at + 5;
    while start < bytes.len() && matches!(bytes[start], b' ' | b'\n' | b'\r' | b'\t') {
        start += 1;
    }
    // A PFA ends the section with a run of zeros and `cleartomark`; binary eexec
    // runs to the end of the file.
    let mut end = bytes.len();
    let tail_at = start.max(bytes.len().saturating_sub(1024));
    let tail = String::from_utf8_lossy(&bytes[tail_at..]);
    if let Some(cut) = tail.find("\n0000000000000000000000000000000000000000000000000000000000000000") {
        end = tail_at + cut;
    }
    Some((start, end))
}

/// Read from `cursor`, past the whitespace: the next text token.
fn token(text: &[u8], cursor: usize) -> Option<(&[u8], usize)> {
    let mut at = cursor;
    while at < text.len() && text[at].is_ascii_whitespace() {
        at += 1;
    }
    let start = at;
    while at < text.len() && !text[at].is_ascii_whitespace() {
        at += 1;
    }
    if at == start {
        return None;
    }
    Some((&text[start..at], at))
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn all_matches(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(found) = find(&haystack[at..], needle) {
        out.push(at + found);
        at += found + needle.len();
    }
    out
}

/// The glyph names of a Type 1 program (`/FontFile`), or `None` when the bytes
/// are not one.
///
/// The read procedure in the private dictionary is not always called `RD`:
/// pdfTeX's FalseType fonts define it as `-|`. Both are accepted. Its *effect* is
/// what matters - `readstring` of an explicit length - so each entry is stepped
/// over by its declared length and never by scanning for a byte.
///
/// Everything here works on *bytes*. Widening the decrypted section to a `String`
/// first would re-encode every byte above 0x7f as two, and every offset after the
/// first one would point somewhere else - which reads as a font quietly missing
/// a glyph rather than as a bug.
pub fn type1_names(bytes: &[u8]) -> Option<GlyphNames> {
    let flat = flatten(bytes);
    let (start, end) = split_eexec(&flat)?;
    if start >= end || end > flat.len() {
        return None;
    }
    let header = String::from_utf8_lossy(&flat[..start]).into_owned();
    let len_iv: i32 = header
        .find("/lenIV")
        .and_then(|at| header[at + 6..].split_whitespace().next()?.parse().ok())
        .unwrap_or(4);
    let skip = len_iv.max(0) as usize;
    let decrypted = decrypt(&flat[start..end], EEXEC_KEY);
    if skip >= decrypted.len() {
        return None;
    }
    let plain = &decrypted[skip..];

    // The font's built-in encoding is cleartext, in the header:
    // `dup <code> /<name> put`.
    let mut encoding: Vec<(u32, String)> = Vec::new();
    let header_bytes = flat[..start].to_vec();
    for at in all_matches(&header_bytes, b"dup") {
        let mut cursor = at + 3;
        let Some((code, next)) = token(&header_bytes, cursor) else {
            continue;
        };
        cursor = next;
        let Some((name, next)) = token(&header_bytes, cursor) else {
            continue;
        };
        cursor = next;
        let Some((proc, _)) = token(&header_bytes, cursor) else {
            continue;
        };
        if proc != b"put" {
            continue;
        }
        let Ok(code) = std::str::from_utf8(code).unwrap_or("").parse::<u32>() else {
            continue;
        };
        let Some(name) = name.strip_prefix(b"/") else {
            continue;
        };
        encoding.push((code, latin1(name)));
    }

    let mut names: Vec<String> = Vec::new();
    let mut cursor = find(plain, b"/CharStrings")?;
    while cursor < plain.len() {
        let Some((name, next)) = token(plain, cursor) else {
            break;
        };
        if name == b"end" {
            break;
        }
        let Some(name) = name.strip_prefix(b"/") else {
            cursor = next;
            continue;
        };
        let Some((length, next)) = token(plain, next) else {
            break;
        };
        let Ok(length) = std::str::from_utf8(length).unwrap_or("").parse::<usize>() else {
            cursor = next;
            continue;
        };
        let Some((proc, next)) = token(plain, next) else {
            break;
        };
        if proc != b"RD" && proc != b"-|" {
            cursor = next;
            continue;
        }
        names.push(latin1(name));
        // One optional space follows the procedure, then that many bytes of
        // binary charstring.
        let mut body = next;
        if body < plain.len() && plain[body] == b' ' {
            body += 1;
        }
        cursor = body + length;
    }
    if names.is_empty() {
        return None;
    }
    Some(GlyphNames { names, encoding })
}
