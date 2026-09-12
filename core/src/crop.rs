//! Cropping a page to its content, with the rules PaperCutter uses.
//!
//! The idea is the one a print shop means by "trim to the type": every page is
//! reduced to the bounding box of what is actually on it, so a PDF whose pages
//! carry two inches of blank margin can be read (or printed) without it. The
//! rules exist because some marks on a page are not content - a publisher's
//! footer, an arXiv stamp in the margin, a bare page number - and a box built
//! from *everything* would keep the margins that exist only to hold them.
//!
//! Ported from PaperCutter's `cutter.py`, which is the reference for both the
//! boxes and the rules; each rule below says which line of it it came from. Two
//! details of that script are deliberately kept because they are what it does,
//! not because they are obviously right:
//!
//!  - a drawing counts only when it is *fully inside* the page box and more than
//!    [`MIN_DRAWING_HEIGHT`] tall, so a rule or a figcaption frame is kept and a
//!    hairline is not;
//!  - the top of the box is clamped to the page (`box[1] = max(0, box[1])`),
//!    which is what stops a mark in the trim area from pulling it upwards.
//!
//! This is the part of the TypeScript pipeline that asked MuPDF the most
//! questions - every character's quad, and the bound of every fill, stroke, image
//! and shading - and it is here rather than in the host because all of it is
//! reading the document. The host asks for a box; the walk that produces one
//! never leaves this crate.

use std::cell::RefCell;
use std::rc::Rc;

use mupdf::{
    ColorParams, Colorspace, Device, Error, Image, Matrix, NativeDevice, Page, Path, Rect, Shade,
    StrokeState, TextPageFlags,
};

/// Drawings taller than this are kept whatever they contain: a table rule, a
/// figure, a shaded panel. `32` is PaperCutter's number, in page units.
pub const MIN_DRAWING_HEIGHT: f32 = 32.0;

/// A rectangle in page units, with the page's own origin (points, y down).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Box2 {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl Box2 {
    pub fn new(x: f32, y: f32, width: f32, height: f32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// The page's own box, as `fz_bound_page` reports one.
    pub fn from_rect(rect: Rect) -> Self {
        Self::new(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0)
    }

    pub fn right(&self) -> f32 {
        self.x + self.width
    }

    pub fn bottom(&self) -> f32 {
        self.y + self.height
    }

    /// A box with nothing in it, which is how the union of no spans comes out.
    pub fn is_empty(&self) -> bool {
        self.x > self.right() || self.y > self.bottom()
    }

    /// Is `inner` wholly inside this box? PaperCutter's `include_box`.
    ///
    /// A NaN corner makes every comparison false, so a drawing MuPDF could not
    /// bound is kept out rather than dragging the box to infinity - which is what
    /// the reference script's `<=` chain does with one too.
    pub fn contains(&self, inner: &Box2) -> bool {
        self.x <= inner.x
            && self.y <= inner.y
            && self.right() >= inner.right()
            && self.bottom() >= inner.bottom()
    }

    pub fn union(&mut self, other: &Box2) {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        let right = self.right().max(other.right());
        let bottom = self.bottom().max(other.bottom());
        *self = Self::new(x, y, right - x, bottom - y);
    }

    /// The four corners of a quad, folded into the box around all of them.
    ///
    /// MuPDF reports a character's quad as four corners - upper-left,
    /// upper-right, lower-left, lower-right - and not as a rectangle: a glyph set
    /// sideways, like the arXiv stamp in a margin, has corners that share no axis
    /// with the page. Reading only the first two leaves every span a zero-height
    /// line at the top of its glyphs, and a box built from those cuts the bottom
    /// line off the page.
    pub fn from_quad(quad: &mupdf::Quad) -> Self {
        let xs = [quad.ul.x, quad.ur.x, quad.ll.x, quad.lr.x];
        let ys = [quad.ul.y, quad.ur.y, quad.ll.y, quad.lr.y];
        let x = xs.iter().copied().fold(f32::INFINITY, f32::min);
        let y = ys.iter().copied().fold(f32::INFINITY, f32::min);
        Self::new(
            x,
            y,
            xs.iter().copied().fold(f32::NEG_INFINITY, f32::max) - x,
            ys.iter().copied().fold(f32::NEG_INFINITY, f32::max) - y,
        )
    }

    /// As JSON, which is how a host reads a box.
    pub fn json(&self) -> String {
        format!(
            "{{\"x\":{},\"y\":{},\"width\":{},\"height\":{}}}",
            num(self.x),
            num(self.y),
            num(self.width),
            num(self.height)
        )
    }
}

/// A number as JSON prints one: the shortest decimal that reads back as the same
/// float, and never a `NaN`, which JSON has no spelling for.
fn num(v: f32) -> String {
    if !v.is_finite() {
        return "null".into();
    }
    format!("{v}")
}

/// One text run on a page: the string, and the box around all of it.
#[derive(Clone, Debug)]
pub struct Span {
    pub text: String,
    pub box_: Box2,
}

/// The marks a rule can remove, in PaperCutter's order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rule {
    Arxiv,
    ConferenceHeader,
    PageNumber,
    SectionNumber,
    Chapter,
    PrimeAi,
    Title,
}

/// One rule as the host shows it: what it is called, what it removes, and the
/// line of PaperCutter it came from.
pub struct RuleInfo {
    pub rule: Rule,
    pub id: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
    pub source: &'static str,
    /// True when the rule can only work with the document's own title.
    pub needs_title: bool,
}

/// PaperCutter's filter list, in its order, plus the title filter it installs
/// per document (`common_filter_function`). A span matching any enabled rule is
/// left out of the content box.
pub const RULES: [RuleInfo; 7] = [
    RuleInfo {
        rule: Rule::Arxiv,
        id: "arxiv",
        label: "arXiv stamp",
        hint: "the identifier arXiv prints in the left margin",
        source: "s.startswith(\"arXiv:\")",
        needs_title: false,
    },
    RuleInfo {
        rule: Rule::ConferenceHeader,
        id: "conference-header",
        label: "Conference header",
        hint: "the publisher’s line across the top",
        source: "s.startswith(\"Published as a conference paper at\")",
        needs_title: false,
    },
    RuleInfo {
        rule: Rule::PageNumber,
        id: "page-number",
        label: "Page number",
        hint: "a span that is nothing but digits",
        source: "s.lstrip().rstrip().isdigit()",
        needs_title: false,
    },
    RuleInfo {
        rule: Rule::SectionNumber,
        id: "section-number",
        label: "Section number",
        hint: "a heading that opens with “3.1.”",
        source: "re.match(\"[0-9]\\\\.[0-9]\\\\.\", s)",
        needs_title: false,
    },
    RuleInfo {
        rule: Rule::Chapter,
        id: "chapter",
        label: "Chapter heading",
        hint: "a heading that opens with “CHAPTER 1.”",
        source: "re.match(\"CHAPTER [0-9]\\\\.\", s)",
        needs_title: false,
    },
    RuleInfo {
        rule: Rule::PrimeAi,
        id: "prime-ai",
        label: "PRIME AI watermark",
        hint: "the line “PRIME AI paper”",
        source: "s == \"PRIME AI paper\"",
        needs_title: false,
    },
    RuleInfo {
        rule: Rule::Title,
        id: "title",
        label: "Running title",
        hint: "the document’s own title, repeated as a header",
        source: "s == title  (common_filter_function)",
        needs_title: true,
    },
];

impl Rule {
    pub fn id(&self) -> &'static str {
        RULES
            .iter()
            .find(|info| info.rule == *self)
            .map(|info| info.id)
            .unwrap_or("")
    }

    /// Does this span carry the mark the rule removes?
    pub fn test(&self, text: &str, title: &str) -> bool {
        match self {
            Rule::Arxiv => text.starts_with("arXiv:"),
            Rule::ConferenceHeader => text.starts_with("Published as a conference paper at"),
            // Python's `isdigit()` also accepts non-ASCII digits; the port keeps
            // to ASCII, which is what a numbered page is actually set in.
            Rule::PageNumber => {
                let trimmed = text.trim();
                !trimmed.is_empty() && trimmed.bytes().all(|b| b.is_ascii_digit())
            }
            Rule::SectionNumber => starts_with_pattern(text, b"d.d."),
            Rule::Chapter => starts_with_pattern(text, b"CHAPTER d."),
            Rule::PrimeAi => text == "PRIME AI paper",
            // No title, no match: PaperCutter only installs this filter when it
            // has one.
            Rule::Title => !title.is_empty() && text == title,
        }
    }
}

/// `^<pattern>$` where `d` stands for one ASCII digit and every other byte is
/// itself - the two `re.match` rules, spelled out so the expression is not a
/// dependency.
fn starts_with_pattern(text: &str, pattern: &[u8]) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= pattern.len()
        && pattern.iter().enumerate().all(|(i, want)| match want {
            b'd' => bytes[i].is_ascii_digit(),
            other => bytes[i] == *other,
        })
}

/// The selection a caller asked for, in the order the rules are declared:
/// unknown ids dropped, duplicates collapsed.
pub fn normalise_rules(ids: &[String]) -> Vec<Rule> {
    RULES
        .iter()
        .filter(|info| ids.iter().any(|id| id == info.id))
        .map(|info| info.rule)
        .collect()
}

/// Split a `a,b,c` list of rule ids, which is how the bridge passes a selection.
pub fn parse_rules(list: &str) -> Vec<Rule> {
    let ids: Vec<String> = list
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect();
    normalise_rules(&ids)
}

/// Every rule, for a host that has to draw the menu it is choosing from.
pub fn rules_json() -> String {
    let mut out = String::from("[");
    for (i, info) in RULES.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!(
            "{{\"id\":\"{}\",\"label\":{},\"hint\":{},\"source\":{},\"needsTitle\":{}}}",
            info.id,
            crate::json::quote(info.label),
            crate::json::quote(info.hint),
            crate::json::quote(info.source),
            info.needs_title
        ));
    }
    out.push(']');
    out
}

/// True when this span carries one of the selected marks.
fn filtered(text: &str, rules: &[Rule], title: &str) -> bool {
    rules.iter().any(|rule| rule.test(text, title))
}

/// The content box of one page, or `None` when there is nothing to crop to.
///
/// This is PaperCutter's `crop_page` up to the `set_cropbox` call: the union of
/// the spans no rule removes and the drawings big enough to be content, with the
/// top clamped to the page and the whole thing intersected with it.
pub fn content_box(
    spans: &[Span],
    drawings: &[Box2],
    page: Box2,
    title: &str,
    rules: &[Rule],
) -> Option<Box2> {
    if rules.is_empty() {
        return None;
    }

    let mut box_ = Box2::new(f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    for span in spans {
        if span.text.is_empty() || filtered(&span.text, rules, title) {
            continue;
        }
        box_.union(&span.box_);
    }
    for rect in drawings {
        if rect.height <= MIN_DRAWING_HEIGHT || !page.contains(rect) {
            continue;
        }
        box_.union(rect);
    }

    if box_.is_empty() {
        return None;
    }
    let top = box_.y.max(0.0);
    let left = box_.x.max(page.x);
    let right = box_.right().min(page.right());
    let bottom = box_.bottom().min(page.bottom());
    if left >= right || top >= bottom {
        return None;
    }
    Some(Box2::new(left, top, right - left, bottom - top))
}

/// Grow a box by `padding` on every side, stopped by the page.
///
/// The reference script crops to the content exactly, which on a page whose text
/// reaches the trim is a box with no room to breathe - and a crop box cannot be
/// larger than the page it is cutting, so the page is the outer limit.
pub fn pad_box(box_: Box2, padding: f32, page: Box2) -> Box2 {
    if !padding.is_finite() || padding <= 0.0 {
        return box_;
    }
    let x = (box_.x - padding).max(page.x);
    let y = (box_.y - padding).max(page.y);
    let right = (box_.right() + padding).min(page.right());
    let bottom = (box_.bottom() + padding).min(page.bottom());
    Box2::new(x, y, right - x, bottom - y)
}

/// The flags the reference pipeline reads spans with.
///
/// `vectors=1,preserve-images=1` in the TypeScript engine, which is what
/// PaperCutter's `get_text("dict")` walk is standing in for. The vectors and the
/// images are not used for a box - `page_drawings` is - but the *flags* are not
/// neutral: they decide which blocks the text device builds and in what order,
/// and a span list that does not match the reference's is a crop box that does
/// not match either. Measured: without them this reader finds one extra span in
/// the attention diagram of 1706.03762 and the box around it grows to include a
/// figure label the reference leaves out.
const TEXT_FLAGS: TextPageFlags =
    TextPageFlags::COLLECT_VECTORS.union(TextPageFlags::PRESERVE_IMAGES);

/// Every text run on a page, in reading order.
///
/// MuPDF reports characters, not spans; a span is the run of characters that
/// share a font, a size and a colour, which is how PyMuPDF groups them and
/// therefore how PaperCutter's rules see the page. Grouping them the same way
/// matters: "3.1." and the heading it introduces are one span when they are set
/// in one style, and the rule for a section number then takes the whole heading
/// out of the box - exactly as the reference script does.
pub fn page_spans(page: &Page) -> Result<Vec<Span>, Error> {
    let text_page = page.to_text_page(TEXT_FLAGS)?;
    let mut spans: Vec<Span> = Vec::new();
    let mut key = String::new();
    for block in text_page.blocks() {
        for line in block.lines() {
            // A run does not survive a line break, which is where the reference
            // resets it.
            key.clear();
            for ch in line.chars() {
                let Some(text) = ch.char() else { continue };
                let style = format!(
                    "{}|{}|{}",
                    ch.font().map(|font| font.name().to_string()).unwrap_or_default(),
                    ch.size(),
                    ch.argb()
                );
                let quad = Box2::from_quad(&ch.quad());
                if style != key {
                    key = style;
                    spans.push(Span {
                        text: String::new(),
                        box_: quad,
                    });
                }
                let run = spans.last_mut().expect("a run was just pushed");
                run.text.push(text);
                // A quad is four corners, and a span is the box around all of
                // them.
                run.box_.union(&quad);
            }
        }
    }
    Ok(spans)
}

/// The boxes of everything the page draws - the `get_bboxlog()` half of
/// PaperCutter, which keeps a figure or a table frame in the crop while a
/// hairline or a clipped-away path stays out of it.
///
/// A device rather than a display list, because the kinds that matter
/// (`fill-path`, `stroke-path`, `fill-image`, `fill-shade`) are the device's own
/// callbacks, and each one arrives with the full transform already applied.
/// `image` and `shade` belong to the caller for the length of the call and must
/// not be dropped here; `path` and `stroke` are kept for us, and are.
pub fn page_drawings(page: &Page) -> Result<Vec<Box2>, Error> {
    let boxes = Rc::new(RefCell::new(Vec::new()));
    {
        let device = Rc::new(RefCell::new(Boxes {
            boxes: Rc::clone(&boxes),
        }));
        let target = Device::from_native(device)?;
        page.run(&target, &Matrix::IDENTITY)?;
    }
    let boxes = Rc::try_unwrap(boxes)
        .map(RefCell::into_inner)
        .unwrap_or_else(|shared| shared.borrow().clone());
    Ok(boxes)
}

/// The device that keeps only the boxes a crop rule cares about.
struct Boxes {
    boxes: Rc<RefCell<Vec<Box2>>>,
}

impl Boxes {
    fn keep(&self, rect: Rect) {
        self.boxes.borrow_mut().push(Box2::from_rect(rect));
    }
}

impl NativeDevice for Boxes {
    fn fill_path(
        &mut self,
        path: &Path,
        _even_odd: bool,
        ctm: Matrix,
        _cs: &Colorspace,
        _color: &[f32],
        _alpha: f32,
        _cp: ColorParams,
    ) {
        // Null stroke: a fill has none, and a `StrokeState` would widen the box
        // by half a unit even at width zero (see `ffi::bound_path`).
        let rect = crate::ffi::bound_path(path, &ctm);
        self.keep(rect);
    }

    fn stroke_path(
        &mut self,
        path: &Path,
        stroke: &StrokeState,
        ctm: Matrix,
        _cs: &Colorspace,
        _color: &[f32],
        _alpha: f32,
        _cp: ColorParams,
    ) {
        if let Ok(rect) = path.bounds(stroke, &ctm) {
            self.keep(rect);
        }
    }

    fn fill_image(&mut self, _img: &Image, ctm: Matrix, _alpha: f32, _cp: ColorParams) {
        self.keep(unit_square(&ctm));
    }

    fn fill_shade(&mut self, shade: &Shade, ctm: Matrix, _alpha: f32, _cp: ColorParams) {
        let rect = crate::ffi::bound(shade, &ctm);
        self.keep(rect);
    }
}

/// An image is drawn into the unit square, transformed; its box is that square's
/// four corners folded together.
fn unit_square(ctm: &Matrix) -> Rect {
    let mut rect = Rect::new(f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    for (x, y) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
        let p = mupdf::Point::new(x, y).transform(ctm);
        rect.x0 = rect.x0.min(p.x);
        rect.y0 = rect.y0.min(p.y);
        rect.x1 = rect.x1.max(p.x);
        rect.y1 = rect.y1.max(p.y);
    }
    rect
}

#[cfg(test)]
mod test {
    use super::*;

    fn span(text: &str, box_: Box2) -> Span {
        Span {
            text: text.to_string(),
            box_,
        }
    }

    fn page() -> Box2 {
        Box2::new(0.0, 0.0, 612.0, 792.0)
    }

    fn rules(ids: &[&str]) -> Vec<Rule> {
        let list: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
        normalise_rules(&list)
    }

    #[test]
    fn each_rule_recognises_its_own_mark_and_nothing_else() {
        assert!(Rule::Arxiv.test("arXiv:1706.03762v7", ""));
        assert!(Rule::ConferenceHeader.test("Published as a conference paper at ICLR", ""));
        assert!(Rule::PageNumber.test("  42  ", ""), "a page number is trimmed first");
        assert!(!Rule::PageNumber.test("42a", ""));
        assert!(!Rule::PageNumber.test("", ""));
        assert!(Rule::SectionNumber.test("3.1. The model", ""));
        assert!(!Rule::SectionNumber.test("3. The model", ""));
        assert!(Rule::Chapter.test("CHAPTER 1. Introduction", ""));
        assert!(Rule::PrimeAi.test("PRIME AI paper", ""));
        assert!(Rule::Title.test("Attention Is All You Need", "Attention Is All You Need"));
        // No title, no match: the reference only installs the filter when it has
        // one.
        assert!(!Rule::Title.test("Attention Is All You Need", ""));
        assert!(!Rule::Arxiv.test("See arXiv:1706.03762v7", ""));
    }

    #[test]
    fn a_selection_keeps_the_declared_order_and_drops_what_it_does_not_know() {
        // Declared order, not the caller's; unknown ids and duplicates gone.
        assert_eq!(
            rules(&["title", "arxiv", "arxiv", "nonsense"]),
            vec![Rule::Arxiv, Rule::Title]
        );
        assert_eq!(rules(&[]), Vec::new());
        assert_eq!(parse_rules(" arxiv , page-number "), vec![Rule::Arxiv, Rule::PageNumber]);
        assert_eq!(parse_rules(""), Vec::new());
    }

    #[test]
    fn the_box_is_the_spans_no_rule_removed() {
        let spans = [
            span("arXiv:1706.03762v7", Box2::new(10.0, 10.0, 80.0, 10.0)),
            span("Attention Is All You Need", Box2::new(100.0, 200.0, 300.0, 20.0)),
            span("21", Box2::new(300.0, 760.0, 10.0, 10.0)),
        ];
        // No rules: nothing to crop to at all.
        assert_eq!(content_box(&spans, &[], page(), "", &[]), None);
        // The arXiv stamp goes, the title and the page number stay.
        let box_ = content_box(&spans, &[], page(), "", &rules(&["arxiv"])).unwrap();
        assert_eq!(box_, Box2::new(100.0, 200.0, 300.0, 570.0));
        // The page number goes too: only the title is left.
        let box_ = content_box(&spans, &[], page(), "", &rules(&["arxiv", "page-number"])).unwrap();
        assert_eq!(box_, Box2::new(100.0, 200.0, 300.0, 20.0));
        // Every span removed: nothing to crop to.
        assert_eq!(
            content_box(
                &spans,
                &[],
                page(),
                "Attention Is All You Need",
                &rules(&["arxiv", "page-number", "title"]),
            ),
            None
        );
    }

    #[test]
    fn a_drawing_counts_only_when_it_is_tall_and_wholly_inside_the_page() {
        let spans = [span("text", Box2::new(100.0, 300.0, 50.0, 10.0))];
        let tall = Box2::new(50.0, 50.0, 400.0, 100.0);
        // Tall enough and inside: kept, and it is what makes the box taller.
        let box_ = content_box(&spans, &[tall], page(), "", &rules(&["arxiv"])).unwrap();
        assert_eq!(box_, Box2::new(50.0, 50.0, 400.0, 260.0));

        // A hairline is a rule, not content.
        let hairline = Box2::new(50.0, 40.0, 400.0, 1.0);
        let box_ = content_box(&spans, &[hairline], page(), "", &rules(&["arxiv"])).unwrap();
        assert_eq!(box_, Box2::new(100.0, 300.0, 50.0, 10.0));

        // Half off the page is not content either - the publisher's bleed.
        let bleeding = Box2::new(-20.0, 50.0, 400.0, 100.0);
        let box_ = content_box(&spans, &[bleeding], page(), "", &rules(&["arxiv"])).unwrap();
        assert_eq!(box_, Box2::new(100.0, 300.0, 50.0, 10.0));
    }

    #[test]
    fn the_top_is_clamped_to_the_page_and_the_rest_is_intersected_with_it() {
        // A mark above the page's top edge must not pull the box up: the
        // reference clamps the top and intersects the sides.
        let spans = [span("stamp", Box2::new(-30.0, -40.0, 700.0, 100.0))];
        let box_ = content_box(&spans, &[], page(), "", &rules(&["arxiv"])).unwrap();
        assert_eq!(box_, Box2::new(0.0, 0.0, 612.0, 60.0));
    }

    #[test]
    fn padding_grows_the_box_but_never_past_the_page() {
        let box_ = Box2::new(100.0, 100.0, 200.0, 200.0);
        assert_eq!(pad_box(box_, 0.0, page()), box_);
        assert_eq!(pad_box(box_, -5.0, page()), box_);
        assert_eq!(pad_box(box_, f32::NAN, page()), box_);
        assert_eq!(pad_box(box_, 6.0, page()), Box2::new(94.0, 94.0, 212.0, 212.0));
        // Stopped by the page's own edges on every side.
        let against = Box2::new(2.0, 2.0, 608.0, 788.0);
        assert_eq!(pad_box(against, 6.0, page()), page());
    }

    #[test]
    fn a_box_with_no_area_is_no_crop() {
        // Zero-width spans: the union has no area, so there is nothing to show.
        let spans = [span("x", Box2::new(10.0, 10.0, 0.0, 0.0))];
        assert_eq!(content_box(&spans, &[], page(), "", &rules(&["arxiv"])), None);
    }

    #[test]
    fn the_menu_is_built_from_the_same_list_the_rules_are() {
        let json = rules_json();
        assert_eq!(json.matches("\"id\":").count(), RULES.len());
        assert!(json.contains("\"label\":\"Page number\""));
        assert!(json.contains("\"needsTitle\":true"));
        // The two apostrophes in the copy are multi-byte, and JSON must not care.
        assert!(json.contains("publisher’s line across the top"));
    }
}
