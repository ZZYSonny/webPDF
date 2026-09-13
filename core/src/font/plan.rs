//! One face per *font*, for the whole document, instead of one per page.
//!
//! A page's font is built from the glyphs that page drew, so every page mints a
//! new family and every page registers a new `@font-face`. Registering a face
//! re-lays-out the document it lands in: Blink's font-update invalidation walks
//! the whole document, measured at 112.9 ms and 3347 "fonts changed" nodes for a
//! single face added to a document holding a 15-page paper. That is what used to
//! force every page into a frame of its own, and with the frame went selection
//! across pages, find-in-page over the paper, and a caret.
//!
//! A font built from the *program* is not limited that way - it can hold every
//! glyph the font has - so one face serves the whole document. What a program
//! cannot say is which *character* each glyph is written as, because that is the
//! PDF's encoding rather than the font's, so the plan walks the document once,
//! drawing nothing, and collects the glyph ids and the codes they were drawn
//! for. The *letters* behind a ligature come from the font dictionaries instead
//! (`program.rs`): `/Differences` names the glyph `fi`, and a `/ToUnicode` entry
//! longer than one character spells it out, which is both cheaper and more
//! faithful than laying the page's characters over its glyphs to work out which
//! ones a glyph swallowed.
//!
//! Walking the display list is not optional, because three of the four corpus
//! documents draw a *substituted* face - no program at all - on nearly every
//! page: only a page handle can draw those glyphs, and only the display list
//! says which ones a page used.

use std::cell::{OnceCell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use mupdf::pdf::PdfPage;
use mupdf::{
    BlendMode, ColorParams, Colorspace, Device, Document, Error, Font, Function, Image, Matrix,
    NativeDevice, PathWalker, Rect, Shade, StrokeState, Text,
};

use super::build::{build_font, Cmd, Ligature, OutlineGlyph, PUA_BASE, PUA_LIMIT};
use super::program::{
    font_objects, page_encodings, program_id, programs_on_page, FontEncoding, Program,
};
use crate::util::{base64, char_count, Digest, OrderedMap};

/// A built face, and everything a host needs to install it.
#[derive(Clone, Debug)]
pub struct Face {
    /// The CSS family the `<text>` elements name.
    pub family: String,
    /// A complete `@font-face` rule, sans the surrounding `<style>` element.
    ///
    /// Its `src` names [`Face::uri`] and not the face's bytes: the core has no
    /// URL namespace to serve a font from, so the rule says *where* the face is
    /// and the host puts its own URL there - `blob:` in a browser, a path beside
    /// the page in a reader that writes one.
    pub css: String,
    /// What [`Face::css`] names the face as, relative to the document that got
    /// the rule: `wpdf-<hash>.woff`. Unique to the face, so a host can serve it
    /// and put its own URL in the rule's place without guessing which face a
    /// rule is about.
    pub uri: String,
    /// The media type of the bytes at [`Face::uri`].
    pub mime: &'static str,
    /// Container the bytes are in: `woff`, or the raw OpenType/CFF font.
    pub format: &'static str,
    /// Size of [`Face::payload`] in bytes.
    pub bytes: usize,
    pub glyph_count: usize,
    /// The compiled font, as `build_font` wrote it. Kept because `dump` holds a
    /// face to the outlines it was built from, which is a question about the
    /// OpenType the glyphs went into rather than about a container.
    pub data: Vec<u8>,
    /// The bytes a host serves at [`Face::uri`]: the same font, in `format`.
    pub payload: Vec<u8>,
    /// The rule with the bytes inline, built the first time a page that has to
    /// stand alone asks for one. A page drawn before the plan is ready carries
    /// its own faces, and a standalone SVG is opened with no host to serve them,
    /// so that form has to exist - but it is base64 and 4/3 the size, so a
    /// document whose faces are served never builds it at all.
    embedded: OnceCell<String>,
}

impl Face {
    /// The rule with the face's bytes in it, for a page with no host to serve it.
    pub fn embedded_css(&self) -> &str {
        self.embedded.get_or_init(|| {
            format!(
                "@font-face{{font-family:'{}';src:url(data:{};base64,{}) format('{}');\
                 font-weight:normal;font-style:normal;font-display:block}}",
                self.family,
                self.mime,
                base64(&self.payload),
                self.format,
            )
        })
    }
}

/// One face's input: what it was compiled from, glyph by glyph.
pub struct CompiledFace {
    pub family: String,
    pub data: Vec<u8>,
    /// (source gid, the codes it is reachable under, its outline in em units,
    /// the advance the source declared).
    pub glyphs: Vec<(u32, Vec<u32>, Vec<Cmd>, Option<f32>)>,
}

/// One glyph the page drew: which font, which id, for which code.
#[derive(Clone, Copy, Debug)]
struct Draw {
    font_id: usize,
    gid: u32,
    code: u32,
}

/// A font a page drew with, as the display list sees it.
struct FontUse {
    name: String,
    /// The handle, for the fonts that have no program to draw from.
    font: Font,
    gids: Vec<u32>,
    codes: OrderedMap<u32, u32>,
}

/// One font of the document, and everything the plan knows about it.
struct Entry {
    key: String,
    name: String,
    program: Option<Program>,
    /// gid -> the outline in em units, or `None` for a glyph that is blank.
    outlines: HashMap<u32, Option<Vec<Cmd>>>,
    /// Every gid the document drew from this font, codes or not.
    seen: HashSet<u32>,
    advances: HashMap<u32, f32>,
    /// code -> gid. The last writer wins, as the per-page pipeline had it.
    by_code: OrderedMap<u32, u32>,
    /// gid -> every code it was drawn for, in the order they were met.
    codes_by_gid: OrderedMap<u32, Vec<u32>>,
    /// gid -> the letters a ligature glyph stands for.
    letters: OrderedMap<u32, String>,
    /// gid -> the code the text is written as. Decided when the font is built.
    code_of: HashMap<u32, u32>,
    /// The glyphs the face has nothing to draw for: a space, and any other glyph
    /// that is blank. They are real glyphs the page may have placed, but a
    /// character written for one is a character the page's own text does not
    /// have - `svg.rs` says why that matters.
    blank: HashSet<u32>,
    /// gid -> the letters the text is written as, for a ligature the built face
    /// has a `liga` rule for.
    letters_of: HashMap<u32, String>,
    face: Option<usize>,
    signature: String,
}

/// What the SVG device asks of the plan: which face draws a page's font, and how
/// a glyph of it is written as text.
pub struct FontPlanRef<'a> {
    pub family: &'a str,
    pub code_of: &'a HashMap<u32, u32>,
    pub blank: &'a HashSet<u32>,
    pub letters_of: &'a HashMap<u32, String>,
}

pub struct Plan {
    entries: Vec<Entry>,
    by_key: HashMap<String, usize>,
    /// Font dictionaries already read, by the resource's indirect object.
    encodings: HashMap<i32, FontEncoding>,
    faces: Vec<Face>,
    complete: bool,
    warned: Vec<String>,
    /// Pages walked so far, and how many there are to walk.
    next_page: i32,
    total_pages: i32,
}

impl Default for Plan {
    fn default() -> Self {
        Self::new()
    }
}

impl Plan {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            by_key: HashMap::new(),
            encodings: HashMap::new(),
            faces: Vec::new(),
            complete: false,
            warned: Vec::new(),
            next_page: 0,
            total_pages: 0,
        }
    }

    /// True once every page has been walked, so no font can appear later.
    pub fn is_complete(&self) -> bool {
        self.complete
    }

    /// How far the walk has got, in pages.
    pub fn walked_pages(&self) -> i32 {
        self.next_page
    }

    /// How many pages the walk has to get through.
    pub fn total_pages(&self) -> i32 {
        self.total_pages
    }

    /// Every face the plan built, for a host that registers them all at once.
    pub fn faces(&self) -> &[Face] {
        &self.faces
    }

    /// Every `@font-face` rule, in the order the faces were built.
    ///
    /// Each rule names its face by URI, and the bytes behind every one of those
    /// URIs are [`Face::payload`] - a host serves them and puts its own URL in
    /// the rule, which is what keeps a quarter of a megabyte of font out of the
    /// stylesheet it writes into the document.
    pub fn stylesheet(&self) -> String {
        self.faces
            .iter()
            .map(|f| f.css.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn warnings(&self) -> &[String] {
        &self.warned
    }

    /// Every face and the glyphs it was compiled from, for a test that wants to
    /// hold the compiled font to its input.
    ///
    /// The codes are the cmap's, rebuilt the way `compile` built it: a glyph
    /// owns the code it was named with, and every other code it was drawn for is
    /// added only where no glyph has claimed it.
    pub fn compiled_faces(&self) -> Vec<CompiledFace> {
        let mut out = Vec::new();
        for entry in &self.entries {
            let Some(face) = entry.face.and_then(|i| self.faces.get(i)) else {
                continue;
            };
            let mut gids: Vec<u32> = entry.outlines.keys().copied().collect();
            gids.sort_unstable();

            let mut claimed: HashMap<u32, u32> = HashMap::new();
            for gid in &gids {
                if let Some(code) = entry.code_of.get(gid) {
                    claimed.entry(*code).or_insert(*gid);
                }
            }
            for gid in &gids {
                for code in entry.codes_by_gid.get(gid).cloned().unwrap_or_default() {
                    claimed.entry(code).or_insert(*gid);
                }
            }
            let mut codes_of: HashMap<u32, Vec<u32>> = HashMap::new();
            for (code, gid) in claimed {
                codes_of.entry(gid).or_default().push(code);
            }

            let glyphs = gids
                .into_iter()
                .filter_map(|gid| {
                    let mut codes = codes_of.remove(&gid)?;
                    codes.sort_unstable();
                    Some((
                        gid,
                        codes,
                        entry.outlines.get(&gid).and_then(|o| o.clone()).unwrap_or_default(),
                        entry.advances.get(&gid).copied(),
                    ))
                })
                .collect();
            out.push(CompiledFace {
                family: face.family.clone(),
                data: face.data.clone(),
                glyphs,
            });
        }
        out
    }

    /// Every entry, as (name, drawn gids, outlines, coded glyphs, has a face).
    /// For diagnosing what a document's fonts became.
    pub fn debug_entries(&self) -> Vec<(String, usize, usize, usize, usize, usize, usize)> {
        self.entries
            .iter()
            .map(|e| {
                (
                    e.name.clone(),
                    e.seen.len(),
                    e.outlines.len(),
                    e.by_code.len(),
                    e.codes_by_gid.len(),
                    e.letters.len(),
                    e.code_of.len(),
                )
            })
            .collect()
    }

    /// The `@font-face` rule of the face that draws an entry, with its bytes in
    /// it - what a page that has to stand alone carries, since nothing is going
    /// to serve a URI it names.
    pub fn face_css(&self, entry: usize) -> Option<&str> {
        let entry = self.entries.get(entry)?;
        Some(self.faces.get(entry.face?)?.embedded_css())
    }

    /// The face that draws one of a page's fonts, or `None` when the plan has
    /// nothing for it and its glyphs have to stay outlines.
    pub fn face_for(&self, entry: usize) -> Option<FontPlanRef<'_>> {
        let entry = self.entries.get(entry)?;
        let family = self.faces.get(entry.face?)?.family.as_str();
        Some(FontPlanRef {
            family,
            code_of: &entry.code_of,
            blank: &entry.blank,
            letters_of: &entry.letters_of,
        })
    }

    /// The plan's entry for every font a page can draw with, by the name MuPDF
    /// reports for it.
    ///
    /// This is the same pairing the per-page pipeline made: a font with an
    /// embedded program is identified by the program's bytes, and one MuPDF
    /// substituted - a base-14 face, with no program at all - by its name and
    /// nothing else.
    pub fn page_entries(&self, page: &PdfPage) -> HashMap<String, usize> {
        let programs = programs_on_page(page);
        let mut out = HashMap::new();
        for font in font_objects(page) {
            let base = font
                .get_dict("BaseFont")
                .ok()
                .flatten()
                .and_then(|o| o.as_name().ok())
                .map(|n| String::from_utf8_lossy(&n).into_owned())
                .unwrap_or_default();
            let descriptor = descriptor_name(&font);
            let program = descriptor
                .as_ref()
                .and_then(|name| programs.get(name))
                .or_else(|| programs.get(&base));
            let key = match program {
                Some(program) => program_id(program),
                None => {
                    let name = descriptor.clone().unwrap_or_else(|| base.clone());
                    format!("named\u{0}{name}")
                }
            };
            let Some(index) = self.by_key.get(&key).copied() else {
                continue;
            };
            if !base.is_empty() {
                out.insert(base, index);
            }
            if let Some(name) = descriptor {
                out.insert(name, index);
            }
        }
        out
    }

    /* ---------------------------------------------------------------- */

    /// Walk the document and build its faces.
    ///
    /// The whole walk is one pass: what a page drew, which code each glyph stood
    /// for, and the outlines of the glyphs no earlier page had drawn.
    pub fn walk(&mut self, doc: &Document) -> Result<(), Error> {
        self.start(doc)?;
        self.step(doc, 0)?;
        Ok(())
    }

    /// Begin a walk: count the pages and start at the first.
    ///
    /// Separate from [`step`](Plan::step) because a host that draws in a browser
    /// cannot afford to walk a 756-page document in one call: [`walk`](Plan::walk)
    /// is `start` and then one `step` with no budget, and the wasm bridge is
    /// `start` and then a `step` per turn, so the page stays alive while the
    /// document is read.
    pub fn start(&mut self, doc: &Document) -> Result<(), Error> {
        self.total_pages = doc.page_count()?;
        self.next_page = 0;
        self.complete = false;
        Ok(())
    }

    /// Walk up to `budget` more pages, or all of them when `budget` is not
    /// positive, and say whether the plan is finished.
    ///
    /// A page that cannot be read is a warning and not a failure: the font it
    /// would have contributed is simply not planned, and every glyph of it stays
    /// an outline, which always renders correctly.
    pub fn step(&mut self, doc: &Document, budget: i32) -> Result<bool, Error> {
        if self.complete {
            return Ok(true);
        }
        let end = if budget <= 0 {
            self.total_pages
        } else {
            self.next_page.saturating_add(budget).min(self.total_pages)
        };
        while self.next_page < end {
            let index = self.next_page;
            self.next_page += 1;
            if let Err(error) = self.walk_page(doc, index) {
                self.warned
                    .push(format!("page {index} could not be planned: {error}"));
            }
        }
        if self.next_page >= self.total_pages {
            self.build();
            self.complete = true;
        }
        Ok(self.complete)
    }

    fn walk_page(&mut self, doc: &Document, index: i32) -> Result<(), Error> {
        let page = PdfPage::try_from(doc.load_page(index)?)?;
        let programs = programs_on_page(&page);

        let collector = Rc::new(RefCell::new(Collector::new()));
        {
            let target = Device::from_native(collector.clone())?;
            page.run(&target, &Matrix::IDENTITY)?;
        }
        let collector = match Rc::try_unwrap(collector) {
            Ok(cell) => cell.into_inner(),
            Err(shared) => std::mem::take(&mut *shared.borrow_mut()),
        };

        let encodings = page_encodings(&page, &programs, &mut self.encodings);
        let letters = draw_letters(&collector.fonts, &collector.draws, &encodings);

        for (font_id, font) in collector.fonts.iter().enumerate() {
            let program = programs.get(&font.name).cloned();
            let key = match &program {
                Some(program) => program_id(program),
                None => format!("named\u{0}{}", font.name),
            };
            let entry = self.entry_index(key, &font.name, program.clone());

            for gid in &font.gids {
                self.entries[entry].seen.insert(*gid);
            }
            // `font.codes` is gid -> the code it was drawn for; the entry keeps
            // both directions, because the cmap is built one way and the letters
            // are looked up the other.
            for (gid, code) in font.codes.iter() {
                self.entries[entry].by_code.set(*code, *gid);
                let codes = self.entries[entry].codes_by_gid.entry_default(*gid);
                if !codes.contains(code) {
                    codes.push(*code);
                }
            }
            if let Some(by_gid) = letters.get(&font_id) {
                for (gid, text) in by_gid.iter() {
                    if !self.entries[entry].letters.contains_key(gid) {
                        self.entries[entry].letters.set(*gid, text.clone());
                    }
                }
            }

            // A font with no program has no bytes to read, but the display list
            // is holding the substituted face: draw the glyphs it has not drawn
            // yet. A font *with* a program is drawn from the program at build
            // time, where the bytes are the same for every page.
            if program.is_none() {
                let fresh: Vec<u32> = font
                    .gids
                    .iter()
                    .copied()
                    .filter(|gid| !self.entries[entry].outlines.contains_key(gid))
                    .collect();
                if !fresh.is_empty() {
                    let drawn = draw_glyphs(&font.font, &fresh);
                    let slot = &mut self.entries[entry];
                    for (gid, cmds) in drawn.outlines {
                        slot.outlines.insert(gid, cmds);
                    }
                    for (gid, advance) in drawn.advances {
                        slot.advances.insert(gid, advance);
                    }
                }
            }
        }
        Ok(())
    }

    /// The index of the entry for a font, creating it the first time the font is
    /// met.
    fn entry_index(&mut self, key: String, name: &str, program: Option<Program>) -> usize {
        if let Some(index) = self.by_key.get(&key) {
            return *index;
        }
        let index = self.entries.len();
        self.by_key.insert(key.clone(), index);
        self.entries.push(Entry {
            key,
            name: name.to_string(),
            program,
            outlines: HashMap::new(),
            seen: HashSet::new(),
            advances: HashMap::new(),
            by_code: OrderedMap::new(),
            codes_by_gid: OrderedMap::new(),
            letters: OrderedMap::new(),
            code_of: HashMap::new(),
            blank: HashSet::new(),
            letters_of: HashMap::new(),
            face: None,
            signature: String::new(),
        });
        index
    }

    /// Draw every glyph the document's own programs can supply and the pages did
    /// not, then compile every face.
    fn build(&mut self) {
        for index in 0..self.entries.len() {
            if let Some(program) = self.entries[index].program.clone() {
                let fresh: Vec<u32> = self.entries[index]
                    .seen
                    .iter()
                    .copied()
                    .filter(|gid| !self.entries[index].outlines.contains_key(gid))
                    .collect();
                if !fresh.is_empty() {
                    if let Ok(font) = Font::from_bytes(&program.name, &program.bytes) {
                        let drawn = draw_glyphs(&font, &fresh);
                        let entry = &mut self.entries[index];
                        for (gid, cmds) in drawn.outlines {
                            entry.outlines.insert(gid, cmds);
                        }
                        for (gid, advance) in drawn.advances {
                            entry.advances.insert(gid, advance);
                        }
                    }
                }
            }
            self.compile(index);
        }
    }

    /// Decide what every glyph of one font is written as, and build the face.
    fn compile(&mut self, index: usize) {
        let gids: Vec<u32> = {
            let mut gids: Vec<u32> = self.entries[index].outlines.keys().copied().collect();
            gids.sort_unstable();
            gids
        };
        if gids.is_empty() {
            return;
        }
        // Which of them there is nothing to draw for. Read from the outlines
        // rather than from the font builder's output, because this is what the
        // page itself drew: a glyph whose outline is empty leaves no mark.
        let blank: HashSet<u32> = gids
            .iter()
            .copied()
            .filter(|gid| {
                self.entries[index]
                    .outlines
                    .get(gid)
                    .and_then(|o| o.as_ref())
                    .map(|cmds| cmds.is_empty())
                    .unwrap_or(true)
            })
            .collect();
        // What this face is, hashed from the outlines' own numbers: spelling a
        // glyph out as text costs a `format!` per path command, and a
        // specification's faces hold hundreds of thousands of them.
        let signature = {
            let mut digest = Digest::new();
            for gid in &gids {
                digest.u32(*gid);
                if let Some(Some(cmds)) = self.entries[index].outlines.get(gid) {
                    for cmd in cmds {
                        hash_cmd(&mut digest, *cmd);
                    }
                }
                if let Some(codes) = self.entries[index].codes_by_gid.get(gid) {
                    for code in codes {
                        digest.u32(*code);
                    }
                }
                digest.end_field();
            }
            digest.name()
        };
        if self.entries[index].face.is_some() && self.entries[index].signature == signature {
            return;
        }
        // A code belongs to one glyph or it belongs to none: a program used with
        // two encodings can name the same code for two different glyphs, and a
        // cmap that guessed would draw the wrong letter. Decided from scratch, so
        // a font that grew is a font that is encoded again rather than one
        // carrying the answers of an earlier, smaller self.
        let entry = &mut self.entries[index];
        entry.blank = blank;
        entry.code_of.clear();
        entry.letters_of.clear();
        let mut assigned: HashSet<u32> = HashSet::new();
        // A glyph that stands for several letters is not the letter the display
        // list named it with: `fi` arrives as `f` from a document that names a
        // ligature after its first letter, and a font that took that `f` would
        // take it away from the real `f`.
        let by_code: Vec<(u32, u32)> = entry.by_code.iter().map(|(c, g)| (*c, *g)).collect();
        for (code, gid) in by_code {
            if !entry.outlines.contains_key(&gid)
                || entry.letters.contains_key(&gid)
                || assigned.contains(&code)
            {
                continue;
            }
            entry.code_of.insert(gid, code);
            assigned.insert(code);
        }
        // A ligature keeps the one character Unicode has for it, so the glyph is
        // reachable by name as well as by its letters.
        let letters: Vec<(u32, String)> = entry
            .letters
            .iter()
            .map(|(gid, text)| (*gid, text.clone()))
            .collect();
        for (gid, text) in letters {
            if !entry.outlines.contains_key(&gid) {
                continue;
            }
            let Some(code) = ligature_code(&text) else {
                continue;
            };
            if assigned.contains(&code) {
                continue;
            }
            entry.code_of.insert(gid, code);
            assigned.insert(code);
        }
        // Anything left is reachable by a private-use code: every glyph the
        // document wrote a character for is one the browser can be asked to draw.
        // A glyph no page could name at all is *not* - MuPDF reports no character
        // for it, and inventing one would put a private-use character into the
        // text where the per-page pipeline left an outline.
        let mut next_pua = PUA_BASE;
        for gid in &gids {
            if entry.code_of.contains_key(gid) {
                continue;
            }
            let named = entry
                .codes_by_gid
                .get(gid)
                .map(|c| !c.is_empty())
                .unwrap_or(false)
                || entry.letters.contains_key(gid);
            if !named {
                continue;
            }
            while next_pua <= PUA_LIMIT && assigned.contains(&next_pua) {
                next_pua += 1;
            }
            if next_pua > PUA_LIMIT {
                continue;
            }
            entry.code_of.insert(*gid, next_pua);
            assigned.insert(next_pua);
            next_pua += 1;
        }

        // The cmap is built here rather than handed to the font builder, because
        // a code has to reach exactly one glyph. Every code a glyph was drawn
        // with goes in - a page that asks for it under its own name must find it
        // - but a code another glyph already owns is *left out*, not written
        // twice: the writer keeps the last glyph to claim one, so a second claim
        // draws the wrong letter.
        let mut cmap: OrderedMap<u32, u32> = OrderedMap::new();
        for gid in &gids {
            if let Some(code) = entry.code_of.get(gid) {
                if !cmap.contains_key(code) {
                    cmap.set(*code, *gid);
                }
            }
        }
        for gid in &gids {
            for code in entry.codes_by_gid.get(gid).cloned().unwrap_or_default() {
                if !cmap.contains_key(&code) {
                    cmap.set(code, *gid);
                }
            }
        }
        let mut codes_of: OrderedMap<u32, Vec<u32>> = OrderedMap::new();
        for (code, gid) in cmap.iter() {
            let list = codes_of.entry_default(*gid);
            list.push(*code);
        }

        // What the shaper will look up when it reads the letters of a ligature:
        // the cmap as the font is about to be written, backwards. A letter this
        // font has no glyph for is one the browser could not lay out, so the rule
        // is not written for it and the glyph stays reachable under its own
        // character.
        let mut by_code_out: HashMap<u32, u32> = HashMap::new();
        for (code, gid) in cmap.iter() {
            by_code_out.insert(*code, *gid);
        }
        let mut ligatures: Vec<Ligature> = Vec::new();
        let letters: Vec<(u32, String)> = entry
            .letters
            .iter()
            .map(|(gid, text)| (*gid, text.clone()))
            .collect();
        for (gid, text) in letters {
            if !codes_of.contains_key(&gid) || char_count(&text) < 2 {
                continue;
            }
            let mut components: Vec<u32> = Vec::new();
            let mut complete = true;
            for ch in text.chars() {
                let Some(component) = by_code_out.get(&(ch as u32)).copied() else {
                    complete = false;
                    break;
                };
                if component == gid || components.contains(&component) {
                    complete = false;
                    break;
                }
                components.push(component);
            }
            if !complete {
                continue;
            }
            ligatures.push(Ligature {
                letters: components,
                by: gid,
            });
            entry.letters_of.insert(gid, text);
        }

        let mut glyphs: Vec<OutlineGlyph> = Vec::new();
        for gid in &gids {
            let Some(codes) = codes_of.get(gid) else {
                continue;
            };
            if codes.is_empty() {
                continue;
            }
            glyphs.push(OutlineGlyph {
                gid: *gid,
                cmds: entry
                    .outlines
                    .get(gid)
                    .and_then(|o| o.clone())
                    .unwrap_or_default(),
                codes: codes.clone(),
                advance_em: entry.advances.get(gid).copied(),
            });
        }
        if glyphs.is_empty() {
            return;
        }

        // The name *is* the face: it is what a page's `<text>` names and what
        // the URI is built from, so it is a hash of everything the face holds -
        // the program it came from, the glyphs, the codes they answer to, and
        // the ligatures written for them.
        let mut digest = Digest::new();
        // The program comes first: two subsets of one font are different faces
        // even when they draw the same glyphs under the same codes.
        digest.bytes(entry.key.as_bytes());
        digest.end_field();
        for g in &glyphs {
            digest.u32(g.gid);
            for code in &g.codes {
                digest.u32(*code);
            }
            for cmd in &g.cmds {
                hash_cmd(&mut digest, *cmd);
            }
            digest.end_field();
        }
        for ligature in &ligatures {
            digest.u32(ligature.by);
            for gid in &ligature.letters {
                digest.u32(*gid);
            }
            digest.end_field();
        }
        let family = format!("wpdf-{}", digest.name());
        let Some(built) = build_font(&glyphs, &ligatures, &family, 1000) else {
            return;
        };
        // WOFF where deflating helps, which is nearly always: the face is handed
        // over as one blob per document and served from a URI, so the container
        // is the whole of what a browser has to fetch for it.
        let (payload, format, mime, label, ext) = match super::woff::encode(&built.data) {
            Some(woff) => (woff, "woff", "font/woff", "woff", "woff"),
            None => (built.data.clone(), "opentype", "font/otf", "opentype", "otf"),
        };
        // The family is already a content hash, so the URI it names is unique to
        // this face and stable for this document.
        let uri = format!("{family}.{ext}");
        let css = format!(
            "@font-face{{font-family:'{family}';src:url(\"{uri}\") format('{label}');\
             font-weight:normal;font-style:normal;font-display:block}}"
        );
        let face = Face {
            family,
            css,
            uri,
            mime,
            format,
            bytes: payload.len(),
            glyph_count: built.glyph_count,
            data: built.data.clone(),
            payload,
            embedded: OnceCell::new(),
        };
        self.faces.push(face);
        let entry = &mut self.entries[index];
        entry.face = Some(self.faces.len() - 1);
        entry.signature = signature;
    }
}

/// The `/FontName` of a font's descriptor, which is what MuPDF names a loaded
/// font after.
fn descriptor_name(font: &mupdf::pdf::PdfObject) -> Option<String> {
    let subtype = font
        .get_dict("Subtype")
        .ok()
        .flatten()
        .and_then(|o| o.as_name().ok())
        .map(|n| String::from_utf8_lossy(&n).into_owned())
        .unwrap_or_default();
    let descriptor = if subtype.contains("Type0") || subtype.contains("CIDFont") {
        let mut found = None;
        if let Some(descendants) = font.get_dict("DescendantFonts").ok().flatten() {
            if let Ok(Some(first)) = descendants.get_array(0) {
                found = Some(first);
            }
        }
        found
    } else {
        font.get_dict("FontDescriptor").ok().flatten()
    }?;
    let name = descriptor.get_dict("FontName").ok().flatten()?;
    let name = name.as_name().ok()?;
    let name = String::from_utf8_lossy(&name).into_owned();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Feed one outline command into a digest, tagged so that two commands of
/// different kinds cannot read as one.
fn hash_cmd(digest: &mut Digest, cmd: Cmd) {
    match cmd {
        Cmd::Move(x, y) => {
            digest.u32(0);
            digest.f32(x);
            digest.f32(y);
        }
        Cmd::Line(x, y) => {
            digest.u32(1);
            digest.f32(x);
            digest.f32(y);
        }
        Cmd::Curve(cx1, cy1, cx2, cy2, x, y) => {
            digest.u32(2);
            for value in [cx1, cy1, cx2, cy2, x, y] {
                digest.f32(value);
            }
        }
        Cmd::Close => digest.u32(3),
    }
}

/// The letters each ligature character stands for, by code point.
fn ligature_code(letters: &str) -> Option<u32> {
    Some(match letters {
        "ff" => 0xfb00,
        "fi" => 0xfb01,
        "fl" => 0xfb02,
        "ffi" => 0xfb03,
        "ffl" => 0xfb04,
        "\u{17f}t" => 0xfb05,
        "st" => 0xfb06,
        _ => return None,
    })
}

/// The letters each glyph a page drew stands for, by font id -> glyph id.
///
/// Two sources, in order. The first is the code the display list reported: a
/// document whose encoding is honest names a ligature with the ligature's own
/// character, and Unicode gave that character its letters. It is the only source
/// for a font with no program - a substituted face, which three of the corpus's
/// four documents draw on nearly every page - because there are no glyph names to
/// read.
///
/// The second is the dictionary, for the case a producer writes the ligature's
/// *first* letter as the code (`f` for the `fi` glyph, which is what pdfTeX
/// does), so the code says nothing and `/Differences` or `/ToUnicode` says
/// everything.
fn draw_letters(
    fonts: &[FontUse],
    draws: &[Draw],
    encodings: &HashMap<String, FontEncoding>,
) -> HashMap<usize, OrderedMap<u32, String>> {
    let mut out: HashMap<usize, OrderedMap<u32, String>> = HashMap::new();
    for draw in draws {
        let from_code = ligature_letters(draw.code);
        let from_dictionary = encodings
            .get(&fonts[draw.font_id].name)
            .and_then(|e| e.letters.get(&draw.gid))
            .map(|s| s.as_str());
        let Some(text) = from_code.or(from_dictionary) else {
            continue;
        };
        if char_count(text) < 2 {
            continue;
        }
        out.entry(draw.font_id)
            .or_default()
            .insert(draw.gid, text.to_string());
    }
    out
}

/// The letters a ligature *character* stands for, by code point, as the PDF's
/// own encoding may have stated it.
fn ligature_letters(code: u32) -> Option<&'static str> {
    super::program::ligature_letters(code)
}

/* ------------------------------------------------------------------ */
/* drawing glyphs out of a font                                        */

pub struct Drawn {
    /// gid -> the outline, or `None` for a glyph that draws nothing.
    pub outlines: HashMap<u32, Option<Vec<Cmd>>>,
    pub advances: HashMap<u32, f32>,
}

/// Ask MuPDF to draw every glyph, and read the paths back.
///
/// `Font::outline_glyph` goes through FreeType exactly as the page's own drawing
/// did, so the outline that comes back is the one the page would have shown -
/// not a re-interpretation of a charstring. The path is in em units (1.0 is one
/// em, y up), which is the space the font builder works in.
pub fn draw_glyphs(font: &Font, gids: &[u32]) -> Drawn {
    let mut outlines = HashMap::new();
    let mut advances = HashMap::new();
    for gid in gids {
        if outlines.contains_key(gid) {
            continue;
        }
        // MuPDF reports -1 for a glyph it could not resolve.
        if *gid > i32::MAX as u32 {
            continue;
        }
        let gid_i = *gid as i32;
        if let Ok(advance) = font.advance_glyph(gid_i) {
            if advance.is_finite() && advance > 0.0 {
                advances.insert(*gid, advance);
            }
        }
        let cmds = match font.outline_glyph(gid_i) {
            Ok(Some(path)) => {
                let mut collector = CmdCollector(Vec::new());
                if path.walk(&mut collector).is_ok() {
                    Some(collector.0)
                } else {
                    None
                }
            }
            Ok(None) => None,
            Err(_) => continue,
        };
        outlines.insert(*gid, cmds);
    }
    Drawn { outlines, advances }
}

/// A [`PathWalker`] that copies a path into the command list the font builder
/// takes.
struct CmdCollector(Vec<Cmd>);

impl PathWalker for CmdCollector {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.push(Cmd::Move(x, y));
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.push(Cmd::Line(x, y));
    }
    fn curve_to(&mut self, cx1: f32, cy1: f32, cx2: f32, cy2: f32, ex: f32, ey: f32) {
        self.0.push(Cmd::Curve(cx1, cy1, cx2, cy2, ex, ey));
    }
    fn close(&mut self) {
        self.0.push(Cmd::Close);
    }
}

/* ------------------------------------------------------------------ */
/* the collector device                                                */

/// The device the plan walks the document with: it draws nothing.
///
/// A glyph shown as a clip still counts, and leaving one out would leave its font
/// unknown, so every text callback is followed.
#[derive(Default)]
struct Collector {
    fonts: Vec<FontUse>,
    by_name: HashMap<String, usize>,
    draws: Vec<Draw>,
}

impl Collector {
    fn new() -> Self {
        Self {
            fonts: Vec::new(),
            by_name: HashMap::new(),
            draws: Vec::new(),
        }
    }

    fn note(&mut self, text: &Text) {
        for span in text.spans() {
            // `span.font()` hands over a kept handle, so the font outlives this
            // callback - which is what lets the walk draw its missing glyphs once
            // the page has been interpreted.
            let font = span.font();
            let name = font.name().to_string();
            let font_id = match self.by_name.get(&name) {
                Some(id) => *id,
                None => {
                    let id = self.fonts.len();
                    self.by_name.insert(name.clone(), id);
                    self.fonts.push(FontUse {
                        name,
                        font,
                        gids: Vec::new(),
                        codes: OrderedMap::new(),
                    });
                    id
                }
            };
            for item in span.items() {
                let gid = item.gid();
                if gid < 0 {
                    continue;
                }
                let gid = gid as u32;
                let code = item.ucs();
                let use_ = &mut self.fonts[font_id];
                use_.gids.push(gid);
                // The first code wins for a gid, as the outline writer's own
                // `data-text` did - and a glyph MuPDF could not name is left
                // without one, so the plan and the per-page fonts agree on which
                // glyphs have a character at all.
                if usable_code(code) && !use_.codes.contains_key(&gid) {
                    use_.codes.set(gid, code as u32);
                }
                self.draws.push(Draw {
                    font_id,
                    gid,
                    code: code as u32,
                });
            }
        }
    }
}

fn usable_code(code: i32) -> bool {
    code > 0 && code <= 0x10ffff && code != 0xfffd
}

impl NativeDevice for Collector {
    fn fill_text(
        &mut self,
        text: &Text,
        _ctm: Matrix,
        _cs: &Colorspace,
        _color: &[f32],
        _alpha: f32,
        _cp: ColorParams,
    ) {
        self.note(text);
    }
    fn stroke_text(
        &mut self,
        text: &Text,
        _stroke: &StrokeState,
        _ctm: Matrix,
        _cs: &Colorspace,
        _color: &[f32],
        _alpha: f32,
        _cp: ColorParams,
    ) {
        self.note(text);
    }
    fn clip_text(&mut self, text: &Text, _ctm: Matrix, _scissor: Rect) {
        self.note(text);
    }
    fn clip_stroke_text(
        &mut self,
        text: &Text,
        _stroke: &StrokeState,
        _ctm: Matrix,
        _scissor: Rect,
    ) {
        self.note(text);
    }
    fn ignore_text(&mut self, text: &Text, _ctm: Matrix) {
        self.note(text);
    }
    fn fill_image(&mut self, _img: &Image, _ctm: Matrix, _alpha: f32, _cp: ColorParams) {}
    fn fill_shade(&mut self, _shade: &Shade, _ctm: Matrix, _alpha: f32, _cp: ColorParams) {}
    fn begin_group(
        &mut self,
        _area: Rect,
        _cs: &Colorspace,
        _isolated: bool,
        _knockout: bool,
        _blendmode: BlendMode,
        _alpha: f32,
    ) {
    }
    fn end_group(&mut self) {}
    fn begin_mask(
        &mut self,
        _area: Rect,
        _luminosity: bool,
        _cs: &Colorspace,
        _color: &[f32],
        _cp: ColorParams,
    ) {
    }
    fn end_mask(&mut self, _f: &Function) {}
}
