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

pub mod ffi;
pub mod font;
pub mod svg;
pub mod text;
pub mod util;

use std::rc::Rc;

use mupdf::{Document, Error};

pub use font::plan::Face;
pub use svg::{PageStats, RenderOptions};

/// An open document and the plan for its fonts.
pub struct Core {
    doc: Document,
    plan: Rc<font::plan::Plan>,
}

impl Core {
    /// Open a PDF. Nothing is planned yet: planning is a separate, explicit step
    /// because it walks the whole document.
    pub fn open(bytes: &[u8], magic: &str) -> Result<Self, Error> {
        let doc = Document::from_bytes(bytes, magic)?;
        Ok(Self {
            doc,
            plan: Rc::new(font::plan::Plan::new()),
        })
    }

    pub fn document(&self) -> &Document {
        &self.doc
    }

    pub fn page_count(&self) -> Result<i32, Error> {
        self.doc.page_count()
    }

    /// Walk the document and build its faces: one face per font, for the whole
    /// document.
    ///
    /// This is the expensive part and it is deliberately not hidden inside
    /// `render_page`: it reads every page once.
    pub fn plan_fonts(&mut self) -> Result<(), Error> {
        let plan =
            Rc::get_mut(&mut self.plan).expect("a document being planned cannot be shared yet");
        plan.walk(&self.doc)
    }

    /// True once every page has been walked, so no font can appear later.
    pub fn is_planned(&self) -> bool {
        self.plan.is_complete()
    }

    /// The plan itself, for a probe or a host that wants to ask it directly.
    pub fn plan_for_probe(&self) -> &font::plan::Plan {
        &self.plan
    }

    /// Every face the plan built, for a host that registers them all at once.
    pub fn faces(&self) -> &[Face] {
        self.plan.faces()
    }

    /// Every `@font-face` rule the document's faces need.
    pub fn stylesheet(&self) -> String {
        self.plan.stylesheet()
    }

    /// Anything the walk could not read, as warnings for the host.
    pub fn warnings(&self) -> &[String] {
        self.plan.warnings()
    }

    /// Render one page to SVG.
    pub fn render_page(&self, page: i32, opts: &RenderOptions) -> Result<(String, PageStats), Error> {
        svg::render_page_svg(&self.doc, page, opts, Rc::clone(&self.plan))
    }
}
