//! Cropping a page to its content: a box from everything the page shows, minus
//! the runs a list of regular expressions matches.
//!
//! The idea is the one a print shop means by "trim to the type": every page is
//! reduced to the bounding box of what is actually on it, so a PDF whose pages
//! carry two inches of blank margin can be read (or printed) without it. The
//! patterns exist because some marks on a page are not content - a publisher's
//! footer, an arXiv stamp in the margin, a bare page number - and a box built
//! from *everything* would keep the margins that exist only to hold them.
//!
//! Ported from PaperCutter's `cutter.py`, which is the reference for both the
//! boxes and the marks it removes. The script's predicates are lifted into
//! regular expressions here, and its filter list becomes a *list of
//! expressions*: the core has no opinion about what a rule is called or which
//! ones a reader wants, only about whether a run matches. Two details of the
//! script are deliberately kept because they are what it does, not because they
//! are obviously right:
//!
//!  - a drawing counts only when it is *fully inside* the page box and more than
//!    [`MIN_DRAWING_HEIGHT`] tall, so a rule or a figcaption frame is kept and a
//!    hairline is not;
//!  - the top of the box is clamped to the page (`box[1] = max(0, box[1])`),
//!    which is what stops a mark in the trim area from pulling it upwards.
//!
//! A pattern is found anywhere in a run - Rust's `Regex::is_match` is Python's
//! `re.search`, not `re.match` - so an expression that wants the start of a run
//! says so with `^`. The host's built-in rules carry their own anchors, which is
//! how the script's `startswith` and `re.match` calls are kept exact.
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
use regex::Regex;

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

/// The separator between patterns on the wire.
///
/// A newline, because a regular expression for a line of text has no use for one
/// and the alternative - a comma - is a character expressions do contain. The
/// host joins with it and this side splits on it; a pattern that somehow carried
/// a newline would arrive as two, which is the one thing the format asks of a
/// caller.
pub const SEPARATOR: &str = "\n";

/// A `list` of patterns, as the host sends one: trimmed, empties dropped,
/// duplicates collapsed, order kept.
///
/// The order is the host's - it is the order of the menu - and it matters only
/// for the cache key, since any match removes a run.
pub fn parse_patterns(list: &str) -> Vec<String> {
    let mut patterns: Vec<String> = Vec::new();
    for pattern in list.split(SEPARATOR) {
        let pattern = pattern.trim();
        if pattern.is_empty() || patterns.iter().any(|each| each == pattern) {
            continue;
        }
        patterns.push(pattern.to_string());
    }
    patterns
}

/// Compile a list of patterns, or say which one is not one.
///
/// A reader can type any expression into the menu, so a bad one is an ordinary
/// answer and not a panic: the message is what the menu shows beside the field,
/// and the first pattern that fails is the one it names.
pub fn compile(patterns: &[String]) -> Result<Vec<Regex>, String> {
    patterns
        .iter()
        .map(|pattern| Regex::new(pattern).map_err(|error| describe(&error)))
        .collect()
}

/// A `regex` compile error as one line a reader can act on.
///
/// The crate's `Display` is a three-line rep: the offending pattern, a caret
/// under the column, and then the reason. Only the reason is worth carrying
/// across the boundary; anything unexpected is kept, collapsed, rather than
/// thrown away.
fn describe(error: &regex::Error) -> String {
    let text = error.to_string();
    for line in text.lines() {
        let line = line.trim();
        if let Some(reason) = line.strip_prefix("error:") {
            return reason.trim().to_string();
        }
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// True when this run carries one of the marks the patterns describe.
pub fn filtered(text: &str, patterns: &[Regex]) -> bool {
    patterns.iter().any(|pattern| pattern.is_match(text))
}

/// The content box of one page, or `None` when there is nothing to crop to.
///
/// This is PaperCutter's `crop_page` up to the `set_cropbox` call: the union of
/// the spans no pattern matches and the drawings big enough to be content, with
/// the top clamped to the page and the whole thing intersected with it.
pub fn content_box(
    spans: &[Span],
    drawings: &[Box2],
    page: Box2,
    patterns: &[Regex],
) -> Option<Box2> {
    if patterns.is_empty() {
        return None;
    }

    let mut box_ = Box2::new(f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    for span in spans {
        if span.text.is_empty() || filtered(&span.text, patterns) {
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
/// in one style, and the pattern for a section number then takes the whole
/// heading out of the box - exactly as the reference script does.
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

    /// The patterns the menu ships, as the host sends them, compiled.
    fn patterns(list: &[&str]) -> Vec<Regex> {
        let list: Vec<String> = list.iter().map(|each| each.to_string()).collect();
        compile(&list).expect("the test's patterns compile")
    }

    #[test]
    fn a_pattern_is_found_anywhere_unless_it_says_otherwise() {
        let anywhere = patterns(&["arXiv"]);
        assert!(filtered("see arXiv:1706.03762v7", &anywhere));
        let anchored = patterns(&["^arXiv:"]);
        assert!(filtered("arXiv:1706.03762v7", &anchored));
        assert!(!filtered("See arXiv:1706.03762v7", &anchored));
    }

    #[test]
    fn the_reference_rules_as_the_host_spells_them() {
        // Every predicate of `cutter.py`, as the menu's own expression.
        let arxiv = patterns(&["^arXiv:"]);
        assert!(filtered("arXiv:1706.03762v7", &arxiv));
        let conference = patterns(&["^Published as a conference paper at"]);
        assert!(filtered("Published as a conference paper at ICLR", &conference));
        let number = patterns(&["^\\s*[0-9]+\\s*$"]);
        assert!(filtered("  42  ", &number));
        assert!(!filtered("42a", &number));
        assert!(!filtered("", &number));
        let section = patterns(&["^[0-9]\\.[0-9]\\."]);
        assert!(filtered("3.1. The model", &section));
        assert!(!filtered("3. The model", &section));
        let chapter = patterns(&["^CHAPTER [0-9]\\."]);
        assert!(filtered("CHAPTER 1. Introduction", &chapter));
        // The title rule is a pattern too, escaped by whoever knows the title.
        let title = patterns(&["^Attention Is All You Need$"]);
        assert!(filtered("Attention Is All You Need", &title));
        assert!(!filtered("Attention Is All You Need ", &title));
    }

    #[test]
    fn a_bad_pattern_is_a_message_and_not_a_panic() {
        let error = compile(&["^(".to_string()]).unwrap_err();
        assert!(!error.is_empty(), "the message names the reason");
        assert!(
            !error.contains('\n'),
            "the message is one line: {error:?}"
        );
        assert!(compile(&["^.".to_string()]).is_ok());
    }

    #[test]
    fn the_wire_format_is_a_newline_list_deduplicated() {
        assert_eq!(parse_patterns("^a\n^b"), vec!["^a".to_string(), "^b".to_string()]);
        assert_eq!(parse_patterns(" ^a \n\n^a\n"), vec!["^a".to_string()]);
        assert_eq!(parse_patterns(""), Vec::<String>::new());
        // A comma is an ordinary character in an expression.
        assert_eq!(parse_patterns("a{1,3}"), vec!["a{1,3}".to_string()]);
    }

    #[test]
    fn the_box_is_the_spans_no_pattern_matched() {
        let spans = [
            span("arXiv:1706.03762v7", Box2::new(10.0, 10.0, 80.0, 10.0)),
            span("Attention Is All You Need", Box2::new(100.0, 200.0, 300.0, 20.0)),
            span("21", Box2::new(300.0, 760.0, 10.0, 10.0)),
        ];
        // No patterns: nothing to crop to at all.
        assert_eq!(content_box(&spans, &[], page(), &[]), None);
        // The arXiv stamp goes, the title and the page number stay.
        let box_ = content_box(&spans, &[], page(), &patterns(&["^arXiv:"])).unwrap();
        assert_eq!(box_, Box2::new(100.0, 200.0, 300.0, 570.0));
        // The page number goes too: only the title is left.
        let box_ = content_box(&spans, &[], page(), &patterns(&["^arXiv:", "^\\s*[0-9]+\\s*$"]))
            .unwrap();
        assert_eq!(box_, Box2::new(100.0, 200.0, 300.0, 20.0));
        // Every span removed: nothing to crop to.
        assert_eq!(
            content_box(
                &spans,
                &[],
                page(),
                &patterns(&["^arXiv:", "^\\s*[0-9]+\\s*$", "^Attention Is All You Need$"]),
            ),
            None
        );
    }

    #[test]
    fn a_drawing_counts_only_when_it_is_tall_and_wholly_inside_the_page() {
        let spans = [span("text", Box2::new(100.0, 300.0, 50.0, 10.0))];
        let tall = Box2::new(50.0, 50.0, 400.0, 100.0);
        // Tall enough and inside: kept, and it is what makes the box taller.
        let box_ = content_box(&spans, &[tall], page(), &patterns(&["^arXiv:"])).unwrap();
        assert_eq!(box_, Box2::new(50.0, 50.0, 400.0, 260.0));

        // A hairline is a rule, not content.
        let hairline = Box2::new(50.0, 40.0, 400.0, 1.0);
        let box_ = content_box(&spans, &[hairline], page(), &patterns(&["^arXiv:"])).unwrap();
        assert_eq!(box_, Box2::new(100.0, 300.0, 50.0, 10.0));

        // Half off the page is not content either - the publisher's bleed.
        let bleeding = Box2::new(-20.0, 50.0, 400.0, 100.0);
        let box_ = content_box(&spans, &[bleeding], page(), &patterns(&["^arXiv:"])).unwrap();
        assert_eq!(box_, Box2::new(100.0, 300.0, 50.0, 10.0));
    }

    #[test]
    fn the_top_is_clamped_to_the_page_and_the_rest_is_intersected_with_it() {
        // A mark above the page's top edge must not pull the box up: the
        // reference clamps the top and intersects the sides.
        let spans = [span("stamp", Box2::new(-30.0, -40.0, 700.0, 100.0))];
        let box_ = content_box(&spans, &[], page(), &patterns(&["^arXiv:"])).unwrap();
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
        assert_eq!(
            content_box(&spans, &[], page(), &patterns(&["^arXiv:"])),
            None
        );
    }
}
