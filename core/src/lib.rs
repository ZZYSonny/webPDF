//! The PDF core of webPDF.
//!
//! One MuPDF, inside one module: the page is interpreted and the SVG that the
//! viewer shows is written here, in one pass, by a MuPDF device of our own
//! (`svg::SvgDevice`). Nothing is serialised by MuPDF's own SVG writer and
//! rewritten afterwards - the text runs, the clip paths, the groups and the
//! glyphs are emitted where they are found.
//!
//! Text is written as text. The document is walked once (`font::plan`) to decide,
//! for every font it draws with, what each glyph is written as and to compile one
//! face for the whole document; a page then names those faces from `<text>`
//! elements instead of carrying every glyph as an outline. A glyph the plan
//! cannot promise a face for stays an outline, which always renders correctly.
//!
//! Everything a host needs around that lives here too, because all of it is
//! reading the document: the title, the page boxes and the bookmarks
//! ([`info`]), the content box a crop rule leaves ([`crop`]), the link
//! annotations and their hit areas ([`links`]), and writing the document out
//! again unencrypted. A host that draws this in a browser is expected to know
//! nothing about PDFs; the wasm bridge in `wasm.rs` is the whole of its surface.

pub mod bionic;
pub mod crop;
pub mod ffi;
pub mod font;
pub mod info;
pub mod json;
pub mod links;
pub mod svg;
pub mod text;
pub mod util;
pub mod wasm;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use mupdf::pdf::PdfDocument;
use mupdf::{Document, Error};

pub use crop::Box2;
pub use font::plan::Face;
pub use info::DocInfo;
pub use links::PageLink;
pub use svg::{PageStats, RenderOptions};

/// One page, drawn, with everything the host needs to place it.
pub struct Rendered {
    pub svg: String,
    /// The crop's width when the page was cropped, the page's otherwise - what a
    /// viewer lays the page out by.
    pub width: f32,
    pub height: f32,
    pub stats: PageStats,
    /// The page's link annotations, whether or not the SVG carries hit areas for
    /// them.
    pub links: Vec<PageLink>,
}

/// An open document, what it says about itself, and the plan for its fonts.
pub struct Core {
    doc: Document,
    plan: Rc<font::plan::Plan>,
    info: DocInfo,
    /// Measured crop boxes, keyed by pattern set and page. Small: four numbers each.
    boxes: RefCell<HashMap<String, Option<Box2>>>,
    /// A counter for the scratch file `save` writes through.
    scratch: RefCell<u32>,
}

impl Core {
    /// Open a PDF and read what it says about itself.
    ///
    /// Nothing is planned yet: planning is a separate, explicit step because it
    /// walks the whole document.
    pub fn open(bytes: &[u8], magic: &str) -> Result<Self, Error> {
        let doc = Document::from_bytes(bytes, magic)?;
        let info = info::read(&doc)?;
        Ok(Self {
            doc,
            plan: Rc::new(font::plan::Plan::new()),
            info,
            boxes: RefCell::new(HashMap::new()),
            scratch: RefCell::new(0),
        })
    }

    pub fn document(&self) -> &Document {
        &self.doc
    }

    pub fn info(&self) -> &DocInfo {
        &self.info
    }

    pub fn page_count(&self) -> Result<i32, Error> {
        self.doc.page_count()
    }

    /// Unlock an encrypted document.
    ///
    /// The metadata is read again on success: a locked document reports its page
    /// count and little else, and everything a viewer wants to show is behind the
    /// password that just opened it. Returns whether the password was the right
    /// one.
    pub fn authenticate(&mut self, password: &str) -> Result<bool, Error> {
        let ok = self.doc.authenticate(password)?;
        if ok {
            self.info = info::read(&self.doc)?;
        }
        Ok(ok)
    }

    /// Walk the whole document and build its faces: one face per font, for the
    /// whole document.
    ///
    /// This is the expensive part and it is deliberately not hidden inside
    /// `render_page`: it reads every page once - 0.9 s for a 756-page
    /// specification, since the walk is one pass over the display lists. A host
    /// that cannot block does `plan_start` and then `plan_step` until it says the
    /// plan is done.
    pub fn plan_fonts(&mut self) -> Result<(), Error> {
        let Self { doc, plan, .. } = self;
        plan_mut(plan).walk(doc)
    }

    /// Count the pages and begin the font walk.
    pub fn plan_start(&mut self) -> Result<(), Error> {
        let Self { doc, plan, .. } = self;
        plan_mut(plan).start(doc)
    }

    /// Walk up to `pages` more pages of the font plan; `0` walks all that are
    /// left. Returns true when the plan is complete.
    pub fn plan_step(&mut self, pages: i32) -> Result<bool, Error> {
        let Self { doc, plan, .. } = self;
        plan_mut(plan).step(doc, pages)
    }

    /// True once every page has been walked, so no font can appear later.
    pub fn is_planned(&self) -> bool {
        self.plan.is_complete()
    }

    /// How far the font walk has got, as `(pages walked, pages in all)`.
    pub fn plan_progress(&self) -> (i32, i32) {
        (self.plan.walked_pages(), self.plan.total_pages())
    }

    /// The plan itself, for a probe or a host that wants to ask it directly.
    pub fn plan_for_probe(&self) -> &font::plan::Plan {
        &self.plan
    }

    /// Every face the plan built: the bytes to serve, and the URI
    /// [`stylesheet`](Core::stylesheet) names each of them by.
    pub fn faces(&self) -> &[Face] {
        self.plan.faces()
    }

    /// Every `@font-face` rule the document's faces need, each naming its face
    /// by URI. The bytes at those URIs are [`Face::payload`], from [`faces`](Core::faces).
    pub fn stylesheet(&self) -> String {
        self.plan.stylesheet()
    }

    /// Anything the walk could not read, as warnings for the host.
    pub fn warnings(&self) -> &[String] {
        self.plan.warnings()
    }

    /// Render one page to SVG.
    pub fn render_page(&self, page: i32, opts: &RenderOptions) -> Result<Rendered, Error> {
        let rendered = svg::render_page_svg(&self.doc, page, opts, Rc::clone(&self.plan))?;
        let links = if opts.links {
            self.links(page)?
        } else {
            Vec::new()
        };
        let svg = links::inject(&rendered.svg, &links);
        Ok(Rendered {
            svg,
            width: rendered.width,
            height: rendered.height,
            stats: rendered.stats,
            links,
        })
    }

    /// Every link annotation on a page.
    pub fn links(&self, page: i32) -> Result<Vec<PageLink>, Error> {
        let page = self.doc.load_page(page)?;
        Ok(links::page_links(&self.doc, &page))
    }

    /// The box this page's content occupies under `patterns` - before any
    /// padding, which is a host's setting and costs nothing to change.
    ///
    /// Reading a page costs a few milliseconds and is asked for once per page per
    /// pattern set, so the answers are kept: toggling a rule off and on again is
    /// then free rather than a second pass over the document. `None` means
    /// "nothing to crop to" - an empty page, or no patterns - and the page keeps
    /// its own size.
    ///
    /// The patterns are already compiled: a bad one is the host's to report, and
    /// `crop::compile` is what says so.
    pub fn measure_crop(&self, page: i32, patterns: &[regex::Regex]) -> Result<Option<Box2>, Error> {
        if patterns.is_empty() {
            return Ok(None);
        }
        let key = format!(
            "{}|{page}",
            patterns
                .iter()
                .map(regex::Regex::as_str)
                .collect::<Vec<_>>()
                .join(crop::SEPARATOR)
        );
        if let Some(cached) = self.boxes.borrow().get(&key) {
            return Ok(*cached);
        }

        let loaded = self.doc.load_page(page)?;
        let bounds = Box2::from_rect(loaded.bounds()?);
        let box_ = crop::content_box(
            &crop::page_spans(&loaded)?,
            &crop::page_drawings(&loaded)?,
            bounds,
            patterns,
        );
        self.boxes.borrow_mut().insert(key, box_);
        Ok(box_)
    }

    /// Write the open document out again: MuPDF's own copy of it, compressed and
    /// with no encryption on it.
    ///
    /// Not the bytes the document was opened from. Those are whatever the
    /// reader's file was, and this is a fresh write of the same document, so this
    /// is for handing the document on - to a printer above all, since a PDF is
    /// exactly what a printer wants and a password the printer does not have is
    /// exactly what it must not be handed.
    ///
    /// MuPDF's writer takes a file name and not a buffer (its `pdf_write_document`
    /// would hand back an `fz_buffer`, but only through the raw pointer the safe
    /// wrapper keeps private), so this writes through a scratch file that is read
    /// back and removed. In a browser that file is one in memory; on a desktop it
    /// is one in the temporary directory, and it is gone either way.
    pub fn save(&self) -> Result<Vec<u8>, Error> {
        let pdf = PdfDocument::try_from(self.doc.clone())?;
        let mut options = mupdf::pdf::PdfWriteOptions::default();
        options
            .set_encryption(mupdf::pdf::Encryption::None)
            .set_compress(true);
        let path = self.scratch_path();
        pdf.save_with_options(&path, options)?;
        let bytes = std::fs::read(&path)?;
        let _ = std::fs::remove_file(&path);
        Ok(bytes)
    }

    fn scratch_path(&self) -> String {
        let mut counter = self.scratch.borrow_mut();
        *counter += 1;
        std::env::temp_dir()
            .join(format!(
                "webpdf-save-{}-{}.pdf",
                std::process::id(),
                *counter
            ))
            .to_string_lossy()
            .into_owned()
    }
}

/// The plan for the one document that is being planned.
///
/// The plan is behind an `Rc` because a page's render holds it for the length of
/// the render, and a walk cannot run while one does - so the only moment this can
/// fail is a document being planned twice at once, which the type system already
/// forbids by taking `&mut self`.
fn plan_mut(plan: &mut Rc<font::plan::Plan>) -> &mut font::plan::Plan {
    Rc::get_mut(plan).expect("a document being planned cannot be shared yet")
}
