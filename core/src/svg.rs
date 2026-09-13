//! The SVG device: one pass over the page, emitting the markup the viewer shows.
//!
//! MuPDF hands a device its coordinates in page space (y up), with the transform
//! that takes them to the SVG's own space (y down) already composed, which is
//! what `transform="matrix(...)"` on every element carries. A glyph arrives as
//! its font, its glyph id and its origin, so text is written where it is found -
//! as `<text>` runs when the document's font plan has a face for the glyph, and
//! as an outline when it does not. Nothing is written twice and nothing is
//! rewritten afterwards: the page is interpreted once and the markup comes out of
//! that single pass.
//!
//! The transform maths for a run: a glyph's outline is placed with
//!
//!   matrix(a b c d e f)   applying to y-up em-unit outlines
//!
//! An equivalent `<text>` at font-size K uses a y-down text space, so
//!
//!   A = a/K, B = b/K, C = -c/K, D = -d/K, K = sqrt(|ad - bc|)
//!   (X, Y) = [A C; B D]^-1 (e, f)      - the per-character baseline origin
//!
//! Each character carries its own position, so nothing depends on an advance a
//! rebuilt font only approximates. A glyph written as several characters - a
//! ligature, whose letters the face joins with a `liga` rule - gets a `<tspan>`
//! of its own with one position, because a shaper only joins letters it lays out
//! together.
//!
//! Not every mark on a page is a path or a character. An image is a PNG data URI
//! of the pixels MuPDF decoded, a shading is a real SVG gradient wherever SVG has
//! one that means the same thing and MuPDF's own rasterisation where it does not,
//! a soft mask is a `<mask>` and a tiling pattern a `<pattern>`. Those have
//! definitions of their own, so the device has two sinks - the page and the
//! `<defs>` it is filling - and `begin_defs`/`end_defs` say which one is live.
//! Everything a definition draws is still drawn by this same pass: a mask's
//! second interpretation is the interpreter's `begin_mask`, not a re-run of ours.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt::Write as _;
use std::num::NonZero;
use std::rc::Rc;
use std::sync::OnceLock;

use mupdf::{
    BlendMode, ColorParams, Colorspace, Device, Document, Error, Function, IRect, Image, Matrix,
    NativeDevice, Path, PathWalker, Pixmap, Rect, Shade, StrokeState, Text,
};

use crate::ffi;
use crate::font::plan::Plan;
use crate::text::{is_simple_code, CharGrid, SpaceKind, SpaceMark, ANCHOR_EPSILON};
use crate::util::base64;

/// What the caller can ask of a page's SVG.
#[derive(Debug, Clone, Default)]
pub struct RenderOptions {
    /// Prefix for every id in the document, so `url(#...)` stays apart when
    /// more than one page shares a host page. Empty: no prefix.
    pub id_prefix: String,
    /// Rewrite the root so the SVG fills its container. Default true.
    pub responsive: bool,
    /// Class for the root element, when the host wants one.
    pub class_name: Option<String>,
    /// Embed every face the document uses inside the SVG. Needed for a standalone
    /// SVG; pointless when the host page already carries the stylesheet.
    pub embed_fonts: bool,
    /// Bionic reading: hold every word's first letters at full strength and fade
    /// the rest, so the eye has a fixation point to land on (`bionic.rs`). Off by
    /// default, and off for a page whose text the two devices disagree about.
    pub bionic: bool,
    /// Append a clickable hit area for every link annotation (`links.rs`). Off by
    /// default: they are invisible, so this costs bytes rather than fidelity, and
    /// a host that draws the page as a picture has no use for them.
    pub links: bool,
    /// How much of its strength the faded part of a word keeps, 0..1.
    /// `BIONIC_DIM` (a half) when unset; only meaningful while `bionic` is on.
    pub bionic_dim: Option<f32>,
    /// The window onto the page: `(x, y, width, height)` in page units, which
    /// becomes the root's `viewBox` and its size.
    ///
    /// A crop in the PDF sense - a smaller window onto the same page, never a
    /// deletion of the marks outside it. Every element is still written at the
    /// page's own coordinates, so a cropped page is still the whole page's text,
    /// selectable and searchable, and its link hit areas are where they were.
    /// `None` is the page as it is.
    pub view_box: Option<(f32, f32, f32, f32)>,
}

/// What one page's render cost, and what it became.
#[derive(Debug, Clone, Copy, Default)]
pub struct PageStats {
    /// Glyphs the page drew, text and outlines together.
    pub glyphs: usize,
    /// Glyphs written as text.
    pub as_text: usize,
    /// Glyphs left as outlines, because no face could be promised for them.
    pub as_outlines: usize,
    pub runs: usize,
    /// Space characters written back into the text.
    pub spaces: usize,
    /// Faces the page drew text with. A page that stands alone carries a
    /// `@font-face` rule for each of them; one that names them for a host to
    /// serve reports the same number, so the count says what the page needed
    /// either way.
    pub fonts: usize,
    /// Images written into this page.
    pub images: usize,
    /// Shadings written into this page, as gradients or as rasterised meshes.
    pub shades: usize,
    /// Glyphs written at bionic reading's reduced strength.
    pub faded: usize,
}

/// A number as MuPDF's own writer prints it.
///
/// MuPDF serialises through `%g`, and its `%g` is the *shortest* decimal that
/// reads back as the same float - so `131.3131` is written where six decimal
/// places would have said `131.313095`. Rust's `Display` for `f32` is the same
/// shortest-round-trip form, which is what keeps a coordinate written here
/// identical to the one MuPDF itself would have written rather than merely close
/// to it.
fn num(v: f32) -> String {
    if !v.is_finite() {
        return "0".into();
    }
    if v == 0.0 {
        // Also catches -0, which is a different bit pattern and the same place.
        return "0".into();
    }
    format!("{v}")
}

fn matrix_attr(m: &Matrix) -> String {
    format!(
        "matrix({},{},{},{},{},{})",
        num(m.a),
        num(m.b),
        num(m.c),
        num(m.d),
        num(m.e),
        num(m.f)
    )
}

/// A colour as SVG writes it: `#rrggbb`, through MuPDF's own conversion, so an
/// ICC profile, a separation or a CMYK fill becomes the same sRGB the rest of the
/// renderer would have produced.
fn rgb(cs: &Colorspace, color: &[f32], cp: ColorParams) -> String {
    let rgb_cs = Colorspace::device_rgb();
    let converted = cs
        .convert_color(color, &rgb_cs, None, cp)
        .unwrap_or_else(|_| vec![0.0, 0.0, 0.0]);
    let at = |i: usize| converted.get(i).copied().unwrap_or(0.0);
    hex(quantise([at(0), at(1), at(2)]))
}

fn opacity(alpha: f32) -> Option<String> {
    if alpha >= 1.0 {
        None
    } else {
        Some(num(alpha.max(0.0)))
    }
}

/// How many pixels per point a shading that has no SVG gradient is rasterised
/// at. MuPDF's own SVG device uses one, which is visibly blocky on a mesh that
/// covers a figure; two is still small enough to inline.
const SHADE_RASTER_SCALE: f32 = 2.0;

/// How far inside an end a stop that fades to nothing is placed, as a fraction
/// of the gradient. A shading that was not told to extend is not painted beyond
/// its ends, and SVG's only way to say that is a fade - so the fade is made
/// shorter than a pixel rather than left as a ramp.
const STOP_EPSILON: f32 = 0.0005;

/// A soft mask while it is being filled in.
struct SoftMask {
    id: u32,
    /// A luminosity mask wants an opaque white backdrop; an alpha mask wants a
    /// transparent one. Either way the backdrop is what keeps SVG from
    /// minimising a mask that would otherwise be empty.
    luminosity: bool,
}

/// A tiling pattern while its tile is being drawn.
struct Tile {
    id: u32,
    /// The area to tile, in the pattern's own space.
    area: Rect,
    /// The one tile the pattern repeats, in the pattern's own space.
    view: Rect,
    step: (f32, f32),
    /// The transform from the pattern's space to the page, which is what the
    /// rectangle that is filled with the pattern carries.
    ctm: Matrix,
}

/// The CSS name for a blend mode, or none for the one SVG already does.
fn blend_mode(b: BlendMode) -> Option<&'static str> {
    match b {
        BlendMode::Normal => None,
        BlendMode::Multiply => Some("multiply"),
        BlendMode::Screen => Some("screen"),
        BlendMode::Overlay => Some("overlay"),
        BlendMode::Darken => Some("darken"),
        BlendMode::Lighten => Some("lighten"),
        BlendMode::ColorDodge => Some("color-dodge"),
        BlendMode::ColorBurn => Some("color-burn"),
        BlendMode::HardLight => Some("hard-light"),
        BlendMode::SoftLight => Some("soft-light"),
        BlendMode::Difference => Some("difference"),
        BlendMode::Exclusion => Some("exclusion"),
        BlendMode::Hue => Some("hue"),
        BlendMode::Saturation => Some("saturation"),
        BlendMode::Color => Some("color"),
        BlendMode::Luminosity => Some("luminosity"),
    }
}

fn join_name(join: mupdf::LineJoin) -> &'static str {
    match join {
        mupdf::LineJoin::Miter => "miter",
        mupdf::LineJoin::Round => "round",
        mupdf::LineJoin::Bevel => "bevel",
        _ => "miter",
    }
}

/// The stroke attributes, with the width the caller asks to have written.
///
/// The width is a parameter rather than `state.line_width()` because a glyph
/// outline is in em units: its stroke width is in em units too, and only the
/// caller knows how large the em came out.
fn stroke_attrs(out: &mut String, state: &StrokeState, width: f32) {
    let _ = write!(out, " stroke-width=\"{}\"", num(width));
    if state.line_join() != mupdf::LineJoin::Miter {
        let _ = write!(out, " stroke-linejoin=\"{}\"", join_name(state.line_join()));
    }
    if state.miter_limit() != 10.0 {
        let _ = write!(out, " stroke-miterlimit=\"{}\"", num(state.miter_limit()));
    }
    let dashes = state.dashes();
    if !dashes.is_empty() {
        let list: Vec<String> = dashes.iter().map(|d| num(*d)).collect();
        let _ = write!(out, " stroke-dasharray=\"{}\"", list.join(" "));
    }
}

/// The path data for a MuPDF path, in its own coordinates.
struct PathData(String);

impl PathWalker for PathData {
    fn move_to(&mut self, x: f32, y: f32) {
        let _ = write!(self.0, "M{} {}", num(x), num(y));
    }
    fn line_to(&mut self, x: f32, y: f32) {
        let _ = write!(self.0, "L{} {}", num(x), num(y));
    }
    fn curve_to(&mut self, cx1: f32, cy1: f32, cx2: f32, cy2: f32, ex: f32, ey: f32) {
        let _ = write!(
            self.0,
            "C{} {} {} {} {} {}",
            num(cx1),
            num(cy1),
            num(cx2),
            num(cy2),
            num(ex),
            num(ey)
        );
    }
    fn close(&mut self) {
        self.0.push('Z');
    }
    fn rect(&mut self, x1: f32, y1: f32, x2: f32, y2: f32) {
        let _ = write!(
            self.0,
            "M{} {}L{} {}L{} {}L{} {}Z",
            num(x1),
            num(y1),
            num(x2),
            num(y1),
            num(x2),
            num(y2),
            num(x1),
            num(y2)
        );
    }
}

pub fn path_data(path: &Path) -> String {
    let mut d = PathData(String::new());
    if path.walk(&mut d).is_err() {
        return String::new();
    }
    d.0
}

/// What to close when the device is told a clip or a group has ended.
enum Open {
    Clip,
    Group,
    /// Something that was opened and wrote nothing: a clip whose path came out
    /// empty, or a text clip, which has no group of its own yet. It is on the
    /// stack so that the two sides stay paired, and closing it writes nothing.
    Empty,
}

/// One character of a run: where it starts, and what it says.
struct RunItem {
    x: f32,
    y: f32,
    text: String,
    /// Characters, not code units: a character outside the BMP is still one, and
    /// an escaped `&amp;` is one however long it writes.
    len: usize,
}

/// A stretch of text that will be written as one `<text>` element.
struct Run {
    entry: usize,
    family: String,
    /// The paint the glyphs were filled with, which is what the `<text>` carries.
    paint: String,
    /// The glyph matrix's linear part: the run only holds glyphs that share it.
    linear: (f32, f32, f32, f32),
    items: Vec<RunItem>,
}

/// A MuPDF device that writes the page's SVG.
///
/// Everything it reads from is shared rather than borrowed: MuPDF keeps the
/// device for as long as the page is being interpreted, and asks a `NativeDevice`
/// to be `'static` to do it.
pub struct SvgDevice {
    plan: Rc<Plan>,
    /// MuPDF's name for a font -> the plan entry that draws it.
    fonts: Rc<HashMap<String, usize>>,
    /// The characters the text device read, by position.
    chars: Rc<CharGrid>,
    /// The spaces to write back, in the order the text device reported them.
    marks: Vec<SpaceMark>,
    /// The same marks, by the grid cell of the point they belong in front of.
    mark_cells: HashMap<(i64, i64), Vec<usize>>,
    /// Every glyph that was placed, by cell: where it was, and whether it became
    /// text. A space the page draws itself is already a glyph, and writing the
    /// character a second time would double it - which holds as long as that
    /// glyph became text.
    placed: HashMap<(i64, i64), Vec<(f32, f32, bool)>>,
    run: Option<Run>,
    /// Markup written while a run was open: it waits behind the run's text.
    ///
    /// The text device reports a space before the character that follows it, and
    /// that character can be a glyph no face can promise for - an outline, with
    /// whatever the page drew between the two glyphs. Holding the drawing back
    /// until the run closes is what lets the space reach the run it belongs to
    /// instead of being dropped at the gap.
    pending: String,
    /// Whether markup has been written since the run opened. A run holds glyphs
    /// that are drawn as one text object, so anything drawn in between - however
    /// whitespace-free - ends it.
    run_gap: bool,
    /// The plan entries a run has named, in the order they were first used. What
    /// a standalone SVG has to embed is these faces and no others.
    used: Vec<usize>,
    /// The page, in SVG space. A shading told to extend has no edge of its own,
    /// and a mask needs a region, so both fall back to the page.
    page: (f32, f32),
    /// Prefix for every id, so two pages inlined into one host page stay apart.
    prefix: String,
    /// The strength the faded part of a word is drawn at, or None when bionic
    /// reading is off. `bionic.rs` says why it is a fade rather than a bold.
    bionic: Option<f32>,
    /// How many definitions are open. While this is not zero the markup belongs
    /// to the innermost one rather than to the page.
    in_defs: usize,
    /// The soft masks that are open, outermost first.
    masks: Vec<SoftMask>,
    /// The tiling patterns that are open, outermost first.
    tiles: Vec<Tile>,
    body: String,
    defs: String,
    open: Vec<Open>,
    ids: u32,
    stats: PageStats,
}

fn cell(v: f32) -> i64 {
    (v / crate::text::ANCHOR_EPSILON).round() as i64
}

/// Where `WPDF_TRACE` asks the device to narrate: `x,y`, or just `y`.
///
/// Read once and kept: the device asks for it for every glyph on the page.
fn trace_point() -> &'static Option<(Option<f32>, f32)> {
    static POINT: OnceLock<Option<(Option<f32>, f32)>> = OnceLock::new();
    POINT.get_or_init(|| {
        let raw = std::env::var("WPDF_TRACE").ok()?;
        let mut parts = raw.split(',');
        let first = parts.next()?.trim().parse::<f32>().ok()?;
        match parts.next() {
            Some(second) => Some((Some(first), second.trim().parse::<f32>().ok()?)),
            None => Some((None, first)),
        }
    })
}

fn trace_at(point: &Option<(Option<f32>, f32)>, x: f32, y: f32) -> bool {
    match point {
        Some((Some(px), py)) => (x - px).abs() < 3.0 && (y - py).abs() < 3.0,
        Some((None, py)) => (y - py).abs() < 3.0,
        None => false,
    }
}

impl SvgDevice {
    pub fn new(
        plan: Rc<Plan>,
        fonts: Rc<HashMap<String, usize>>,
        chars: Rc<CharGrid>,
        marks: &[SpaceMark],
        page: (f32, f32),
        opts: &RenderOptions,
    ) -> Self {
        let mut mark_cells: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
        for (i, mark) in marks.iter().enumerate() {
            mark_cells
                .entry((cell(mark.x), cell(mark.y)))
                .or_default()
                .push(i);
        }
        if std::env::var("WPDF_TRACE").is_ok() {
            eprintln!(
                "device: {} marks, first {:?}",
                marks.len(),
                marks.iter().take(3).map(|m| (m.kind, m.x, m.y)).collect::<Vec<_>>()
            );
        }
        Self {
            plan,
            fonts,
            chars,
            marks: marks.to_vec(),
            mark_cells,
            placed: HashMap::new(),
            run: None,
            pending: String::new(),
            run_gap: false,
            used: Vec::new(),
            page,
            prefix: opts.id_prefix.clone(),
            bionic: opts
                .bionic
                .then(|| crate::bionic::bionic_dim(opts.bionic_dim)),
            in_defs: 0,
            masks: Vec::new(),
            tiles: Vec::new(),
            body: String::new(),
            defs: String::new(),
            open: Vec::new(),
            ids: 0,
            stats: PageStats::default(),
        }
    }

    pub fn stats(&self) -> PageStats {
        self.stats
    }

    /// An id, with the host's prefix so that two pages inlined into one document
    /// do not collide - `url(#clip_3)` resolves against the whole document, not
    /// against the `<svg>` it sits in.
    fn id(&self, kind: &str, n: u32) -> String {
        format!("{}{kind}_{n}", self.prefix)
    }

    /// Take the next id of a kind.
    fn next_id_of(&mut self, kind: &str) -> String {
        self.ids += 1;
        format!("{}{kind}_{}", self.prefix, self.ids)
    }

    /// The `@font-face` rules for the faces this page named, in one string with
    /// a newline between them. What a page that has to stand alone carries;
    /// `faces_used` is what `PageStats::fonts` reports.
    fn font_css(&self) -> String {
        let mut seen = String::new();
        for entry in &self.used {
            if let Some(css) = self.plan.face_css(*entry) {
                if !seen.is_empty() {
                    seen.push('\n');
                }
                seen.push_str(css);
            }
        }
        seen
    }

    /// The faces the page drew text with, which is what `PageStats::fonts`
    /// reports.
    ///
    /// It is the length of `used` - a run only opens once `face_for` has
    /// answered - but the plan is asked anyway, so that the count is the same
    /// set of faces `font_css` writes rules for, and asks it through
    /// `face_for` rather than `face_css` because the latter would build a
    /// base64 embedding for every face just to learn that it exists.
    fn faces_used(&self) -> usize {
        self.used
            .iter()
            .filter(|entry| self.plan.face_for(**entry).is_some())
            .count()
    }

    fn next_id(&mut self) -> u32 {
        self.ids += 1;
        self.ids
    }

    /// The marks anchored at a point: the spaces whose next character starts
    /// there, in the order the text device reported them.
    ///
    /// The nine cells around the point are searched, not just the one it rounds
    /// into: two points a thousandth of a point apart can round to neighbouring
    /// cells, and a space that lands in the wrong bucket is a word that loses its
    /// separator.
    fn marks_at(&self, x: f32, y: f32) -> Vec<usize> {
        let (cx, cy) = (cell(x), cell(y));
        let mut out: Vec<usize> = Vec::new();
        for dx in -1..=1 {
            for dy in -1..=1 {
                let Some(bucket) = self.mark_cells.get(&(cx + dx, cy + dy)) else {
                    continue;
                };
                for index in bucket {
                    let mark = &self.marks[*index];
                    if (mark.x - x).abs() <= ANCHOR_EPSILON && (mark.y - y).abs() <= ANCHOR_EPSILON {
                        out.push(*index);
                    }
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Whether the glyph drawn at a point became text.
    fn drawn_as_text(&self, x: f32, y: f32) -> bool {
        let (cx, cy) = (cell(x), cell(y));
        for dx in -1..=1 {
            for dy in -1..=1 {
                let Some(bucket) = self.placed.get(&(cx + dx, cy + dy)) else {
                    continue;
                };
                for (px, py, became_text) in bucket {
                    if (px - x).abs() <= ANCHOR_EPSILON && (py - y).abs() <= ANCHOR_EPSILON {
                        return *became_text;
                    }
                }
            }
        }
        false
    }

    /// Remember where a glyph was placed, and what it became.
    fn note_placed(&mut self, x: f32, y: f32, as_text: bool) {
        self.placed
            .entry((cell(x), cell(y)))
            .or_default()
            .push((x, y, as_text));
    }

    /// Close whatever is on top of the stack.
    ///
    /// What to write is read off the stack rather than off the call, because the
    /// two sides of the device protocol are not always each other's counterpart:
    /// a text clip opens nothing and is closed by `pop_clip`, a clip path opens a
    /// group and is closed by `pop_clip`, and a group is closed by `end_group` -
    /// but a text clip inside a group can have the group's `end_group` arrive on
    /// top of it. Pairing the *stack* is what keeps a page from losing a group,
    /// which is a document that will not load at all.
    fn close_one(&mut self) {
        match self.open.pop() {
            Some(Open::Clip) | Some(Open::Group) => self.emit("</g>"),
            _ => {}
        }
    }

    /// Write markup: straight out when nothing is open, and behind the open run
    /// when one is, so that the run is written where its first glyph was.
    fn emit(&mut self, text: &str) {
        if self.run.is_some() {
            self.pending.push_str(text);
            self.run_gap = true;
        } else if self.in_defs > 0 {
            self.defs.push_str(text);
        } else {
            self.body.push_str(text);
        }
    }

    /// Start a definition: a mask's contents, a pattern's tile, or anything
    /// nested inside either.
    ///
    /// A run that is open is written first, because its text belongs to whatever
    /// was live when it opened and not to the definition about to start.
    fn begin_defs(&mut self) {
        if self.in_defs == 0 {
            self.flush_run();
        }
        self.in_defs += 1;
    }

    /// End the innermost definition. A run opened inside it is written inside it.
    fn end_defs(&mut self) {
        self.flush_run();
        self.in_defs = self.in_defs.saturating_sub(1);
    }

    /// A path element, with the transform MuPDF handed us and the paint the
    /// caller asked for. `stroke` is the stroke state and the width to write for
    /// it, or None when this is a fill.
    ///
    /// The width is passed in rather than read off the stroke state because a
    /// glyph outline is not in user space: it is in em units, so stroking one
    /// needs the width divided by how large an em came out on the page.
    fn path_element(
        &mut self,
        path: &Path,
        ctm: &Matrix,
        paint: &str,
        even_odd: bool,
        stroke: Option<(&StrokeState, f32)>,
    ) {
        let d = path_data(path);
        if d.is_empty() {
            return;
        }
        let mut el = String::new();
        let _ = write!(
            el,
            "<path transform=\"{}\" d=\"{}\"",
            matrix_attr(ctm),
            d
        );
        if let Some((state, width)) = stroke {
            el.push_str(" fill=\"none\"");
            stroke_attrs(&mut el, state, width);
        } else if even_odd {
            el.push_str(" fill-rule=\"evenodd\"");
        }
        el.push_str(paint);
        el.push_str("/>");
        self.emit(&el);
    }

    /// The clip path, and the group that carries it.
    fn clip(&mut self, path: &Path, even_odd: bool, ctm: &Matrix) {
        let d = path_data(path);
        if d.is_empty() {
            self.open.push(Open::Empty);
            return;
        }
        let id = self.next_id_of("clip");
        let _ = write!(
            self.defs,
            "<clipPath id=\"{id}\"><path transform=\"{}\" d=\"{}\"",
            matrix_attr(ctm),
            d
        );
        if even_odd {
            self.defs.push_str(" clip-rule=\"evenodd\"");
        }
        self.defs.push_str("/></clipPath>");
        self.emit(&format!("<g clip-path=\"url(#{id})\">"));
        self.open.push(Open::Clip);
    }

    /// One glyph of a text object as an outline, at the matrix MuPDF gave it.
    fn glyph_outline(&mut self, outline: &Path, m: &Matrix, paint: &str) {
        self.path_element(outline, m, paint, false, None);
    }

    /// Every glyph of a text object, as outlines: the fallback for a glyph no
    /// face can be promised for.
    fn text_outlines(&mut self, text: &Text, ctm: &Matrix, paint: &str, stroke: Option<&StrokeState>) {
        for span in text.spans() {
            let font = span.font();
            let trm = span.trm();
            for item in span.items() {
                let gid = item.gid();
                if gid < 0 {
                    continue;
                }
                let Ok(Some(outline)) = font.outline_glyph(gid) else {
                    continue;
                };
                let m = trm.clone() * Matrix::new_translate(item.x(), item.y()) * ctm.clone();
                // An outline is in em units, so a stroke width in user space has
                // to be divided by how many units an em is on the page - the
                // same expansion the run writer puts in `font-size`. Writing the
                // user-space width here instead is a stem several times too
                // thick, which is what render mode 2 text would come out as.
                let stroke = stroke.map(|state| {
                    let k = (m.a * m.d - m.b * m.c).abs().sqrt();
                    let width = if k > 0.0 {
                        state.line_width() / k
                    } else {
                        state.line_width()
                    };
                    (state, width)
                });
                self.stats.as_outlines += 1;
                self.path_element(&outline, &m, paint, false, stroke);
            }
        }
    }

    /// Write a text object, as `<text>` where the plan has a face and as
    /// outlines where it does not.
    fn text(&mut self, text: &Text, ctm: &Matrix, paint: &str, stroke: Option<&StrokeState>) {
        // A stroked glyph is a different drawing from a filled one and cannot be
        // written as a character, so stroked text stays outlines - which is what
        // the per-page pipeline did with it too. The stroke is the page's, not a
        // fill in the stroke's colour: a hairline stem and a filled stem are not
        // the same mark.
        if let Some(state) = stroke {
            self.text_outlines(text, ctm, paint, Some(state));
            return;
        }
        for span in text.spans() {
            let font = span.font();
            let trm = span.trm();
            let entry = self.fonts.get(font.name()).copied();
            for item in span.items() {
                let gid = item.gid();
                if gid < 0 {
                    continue;
                }
                self.stats.glyphs += 1;
                let m = trm.clone() * Matrix::new_translate(item.x(), item.y()) * ctm.clone();

                // What this glyph is going to be, decided before anything is
                // written because the spaces depend on it: a space the page drew
                // is already text only if the glyph it drew it with becomes text
                // too.
                let gid = gid as u32;
                let trace = trace_at(&trace_point(), m.e, m.f);
                let planned: Option<(usize, String)> = entry.and_then(|entry| {
                    let face = self.plan.face_for(entry)?;
                    // A glyph that stands for several letters is written as those
                    // letters and drawn by the face's own `liga` rule; the plan
                    // only offers them when the face really has the rule.
                    if let Some(letters) = face.letters_of.get(&gid) {
                        return letters
                            .chars()
                            .all(|c| is_simple_code(c as u32))
                            .then(|| (entry, letters.clone()));
                    }
                    let code = *face.code_of.get(&gid)?;
                    if code == 0 || !is_simple_code(code) {
                        return None;
                    }
                    // A glyph the face draws nothing for carries a character the
                    // page's own text may not have: MuPDF reports the space at
                    // the end of a line as the line's break instead, at the very
                    // point the space was drawn. Writing the glyph's space there
                    // would give the text a character the page does not have,
                    // which is how the space between two lines comes out twice.
                    // It stays an outline, and the space the page really has is
                    // written from its mark.
                    if face.blank.contains(&gid) && self.chars.reads_other(m.e, m.f, code) {
                        return None;
                    }
                    Some((entry, char::from_u32(code)?.to_string()))
                });

                let marks: Vec<SpaceMark> = self
                    .marks_at(m.e, m.f)
                    .into_iter()
                    .map(|index| self.marks[index])
                    .filter(|mark| {
                        // A space the page draws itself is already in the SVG as
                        // a glyph, and writing the character a second time would
                        // double it - which holds as long as the glyph became
                        // text.
                        let drop = mark.kind == SpaceKind::Space
                            && self.drawn_as_text(mark.origin_x, mark.origin_y);
                        if trace {
                            eprintln!(
                                "  mark origin ({:.3},{:.3}) target ({:.3},{:.3}) drop {drop}",
                                mark.origin_x, mark.origin_y, mark.x, mark.y
                            );
                        }
                        !drop
                    })
                    .collect();

                if trace {
                    eprintln!(
                        "glyph gid {gid} ucs {} at ({:.3},{:.3}) entry {:?} planned {} open {} marks {:?}",
                        item.ucs(),
                        m.e,
                        m.f,
                        entry,
                        planned.is_some(),
                        self.run.is_some(),
                        marks
                            .iter()
                            .map(|k| (k.kind, k.origin_x, k.x, k.y))
                            .collect::<Vec<_>>()
                    );
                }
                match planned {
                    Some((entry, written)) => {
                        self.stats.as_text += 1;
                        self.note_placed(m.e, m.f, true);
                        self.start_run(entry, paint, &m);
                        for mark in &marks {
                            self.stats.spaces += 1;
                            self.push_item(RunItem {
                                x: mark.x,
                                y: mark.y,
                                text: char::from_u32(mark.code)
                                    .map(|c| c.to_string())
                                    .unwrap_or_default(),
                                len: 1,
                            });
                        }
                        let len = written.chars().count();
                        self.push_item(RunItem {
                            x: m.e,
                            y: m.f,
                            text: written,
                            len,
                        });
                    }
                    None => {
                        // This glyph stays an outline, so there is no text to put
                        // its spaces in front of; the run that is still open is
                        // the same point in the reading order, and putting them
                        // there keeps the offset a space is anchored by. The
                        // drawing then closes that run and takes its place, as
                        // the reference's does.
                        self.note_placed(m.e, m.f, false);
                        for mark in &marks {
                            if self.run.is_some() {
                                self.stats.spaces += 1;
                                self.push_item(RunItem {
                                    x: mark.x,
                                    y: mark.y,
                                    text: char::from_u32(mark.code)
                                        .map(|c| c.to_string())
                                        .unwrap_or_default(),
                                    len: 1,
                                });
                            }
                        }
                        self.flush_run();
                        let Ok(Some(outline)) = font.outline_glyph(gid as i32) else {
                            continue;
                        };
                        self.stats.as_outlines += 1;
                        self.glyph_outline(&outline, &m, paint);
                    }
                }
            }
        }
    }

    /// Start a run, or keep the one that is open when this glyph belongs to it.
    ///
    /// A run holds glyphs of one font, drawn with one paint, sharing one linear
    /// transform. The paint is part of that: a fill colour that changes between
    /// two glyphs is two drawings however alike the rest of the geometry is. So
    /// is anything the page drew in between: those glyphs are not adjacent in
    /// the output however close they are on the page.
    fn start_run(&mut self, entry: usize, paint: &str, m: &Matrix) {
        let linear = (m.a, m.b, m.c, m.d);
        if let Some(run) = &self.run {
            if run.entry == entry && run.paint == paint && run.linear == linear && !self.run_gap {
                return;
            }
        }
        self.flush_run();
        if !self.used.contains(&entry) {
            self.used.push(entry);
        }
        let family = self
            .plan
            .face_for(entry)
            .map(|f| f.family.to_string())
            .unwrap_or_default();
        self.run = Some(Run {
            entry,
            family,
            paint: paint.to_string(),
            linear,
            items: Vec::new(),
        });
    }

    fn push_item(&mut self, item: RunItem) {
        if let Some(run) = &mut self.run {
            run.items.push(item);
        }
    }

    /// Write the run that is open, if there is one, and then the markup that was
    /// written while it was open.
    fn flush_run(&mut self) {
        if let Some(run) = self.run.take() {
            self.write_run(&run);
        }
        if !self.pending.is_empty() {
            let pending = std::mem::take(&mut self.pending);
            if self.in_defs > 0 {
                self.defs.push_str(&pending);
            } else {
                self.body.push_str(&pending);
            }
        }
        self.run_gap = false;
    }

    /// Write one run as a `<text>` element.
    fn write_run(&mut self, run: &Run) {
        if run.items.is_empty() {
            return;
        }
        let (a, b, c, d) = run.linear;
        let k = (a * d - b * c).abs().sqrt();
        if !(k > 0.0) {
            return;
        }
        let (ka, kb, kc, kd) = (a / k, b / k, -c / k, -d / k);
        let det = ka * kd - kb * kc;
        if det.abs() < 1e-12 {
            return;
        }
        // The strength a faded stretch is written at; only ever read while
        // bionic reading is on, which is exactly when `self.bionic` is set.
        let dim = self.bionic.unwrap_or(crate::bionic::BIONIC_DIM);

        let mut xs = Vec::with_capacity(run.items.len());
        let mut ys = Vec::with_capacity(run.items.len());
        // What bionic reading fades, one answer per item; None when it is off,
        // and also when the segments do not account for every character of the
        // run, which writes it plainly rather than faded in the wrong places.
        let fade: Option<Vec<Option<bool>>> = match self.bionic {
            Some(_) => Self::fades(&run.items),
            None => None,
        };
        // A glyph that stands for several characters gets a `<tspan>` of its own:
        // a shaper only joins letters it lays out together, and with a position
        // per character the browser would draw `fi` as an `f` and an `i`, which
        // is not what the page drew. A change of fade does the same, so that the
        // fixation points stay the text as the document set it.
        let mut groups: Vec<(Option<bool>, Vec<usize>)> = Vec::new();
        let mut group: Vec<usize> = Vec::new();
        let mut group_fade = Some(false);
        for (i, item) in run.items.iter().enumerate() {
            xs.push(num((kd * item.x - kc * item.y) / det));
            ys.push(num((-kb * item.x + ka * item.y) / det));
            let this = fade.as_ref().map_or(Some(false), |fade| fade[i]);
            if item.len > 1 {
                if !group.is_empty() {
                    groups.push((group_fade, std::mem::take(&mut group)));
                }
                groups.push((this, vec![i]));
                continue;
            }
            if !group.is_empty() && group_fade != this {
                groups.push((group_fade, std::mem::take(&mut group)));
            }
            group_fade = this;
            group.push(i);
        }
        if !group.is_empty() {
            groups.push((group_fade, group));
        }

        // Into the page, or into the definition being written: text inside a
        // mask's contents belongs to the mask, and inside a pattern's tile to
        // the pattern.
        let sink = if self.in_defs > 0 {
            &mut self.defs
        } else {
            &mut self.body
        };
        let _ = write!(
            sink,
            "<text{} transform=\"matrix({} {} {} {} 0 0)\" font-size=\"{}\" font-family=\"{}\" \
             font-weight=\"normal\" font-style=\"normal\" text-rendering=\"geometricPrecision\" \
             xml:space=\"preserve\">",
            run.paint,
            num(ka),
            num(kb),
            num(kc),
            num(kd),
            num(k),
            run.family
        );
        for (group_fade, indices) in &groups {
            let x: Vec<&str> = indices.iter().map(|i| xs[*i].as_str()).collect();
            let y: Vec<&str> = indices.iter().map(|i| ys[*i].as_str()).collect();
            let _ = write!(sink, "<tspan");
            if *group_fade == Some(true) {
                let _ = write!(sink, " fill-opacity=\"{}\"", num(dim));
            }
            let _ = write!(sink, " x=\"{}\" y=\"{}\">", x.join(" "), y.join(" "));
            for i in indices {
                push_escaped(sink, &run.items[*i].text);
            }
            sink.push_str("</tspan>");
        }
        sink.push_str("</text>");
        self.stats.runs += 1;
        self.stats.faded += groups
            .iter()
            .filter(|(fade, _)| *fade == Some(true))
            .map(|(_, indices)| indices.len())
            .sum::<usize>();
    }

    /// Whether bionic reading fades each item of a run.
    ///
    /// `bionic::segments` marks *letters*, and an item can stand for several of
    /// them: a ligature is one outline and cannot be drawn half dark, so it takes
    /// the answer of the stretch its *first* letter is in. `None` when the
    /// segments do not account for every character of the run, which writes it
    /// unfaded - the caller's concern, and `bionic.rs` says why it is the right
    /// fallback.
    ///
    /// A stretch of nothing but whitespace answers `None` rather than a fade: it
    /// is between two words rather than in one, and fading it would be an
    /// attribute that draws no pixel. It still gets its own `<tspan>`, which is
    /// what keeps a space out of the fixation point next to it.
    fn fades(items: &[RunItem]) -> Option<Vec<Option<bool>>> {
        let text: String = items.iter().map(|item| item.text.as_str()).collect();
        let segments = crate::bionic::segments(&text);
        let total: usize = items.iter().map(|item| item.len).sum();
        if segments.iter().map(|segment| segment.chars).sum::<usize>() != total {
            return None;
        }

        let mut out = Vec::with_capacity(items.len());
        let mut at = 0usize;
        let mut seg = 0usize;
        let mut start = 0usize;
        for item in items {
            while seg < segments.len() && at >= start + segments[seg].chars {
                start += segments[seg].chars;
                seg += 1;
            }
            out.push(match segments.get(seg) {
                None => Some(false),
                Some(segment) if crate::bionic::blank(&segment.text) => None,
                Some(segment) => Some(!segment.fixation),
            });
            at += item.len;
        }
        Some(out)
    }

    /// What the page has so far, wrapped in a root the host can put in a frame.
    pub fn finish(&mut self, width: f32, height: f32, opts: &RenderOptions) -> String {
        self.flush_run();
        // Whatever the page left open is closed here: an SVG with a group left
        // hanging is one no browser will load, and drawing the whole page is a
        // worse failure than drawing it with one clip too few.
        while !self.open.is_empty() {
            self.close_one();
        }
        let font_css = if opts.embed_fonts {
            self.font_css()
        } else {
            String::new()
        };
        self.stats.fonts = self.faces_used();
        let font_css = font_css.as_str();
        // The window onto the page: a crop when the host asked for one, the
        // page's own box otherwise. The elements inside were written at the
        // page's coordinates either way, so this only decides how much of them
        // is shown.
        let (vx, vy, vw, vh) = opts.view_box.unwrap_or((0.0, 0.0, width, height));
        let mut svg = String::with_capacity(self.body.len() + self.defs.len() + 512);
        svg.push_str(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" \
             version=\"1.1\"",
        );
        if opts.responsive {
            let _ = write!(svg, " preserveAspectRatio=\"xMidYMid meet\" width=\"100%\" height=\"100%\"");
        } else {
            let _ = write!(svg, " width=\"{}\" height=\"{}\"", num(vw), num(vh));
        }
        let _ = write!(
            svg,
            " viewBox=\"{} {} {} {}\"",
            num(vx),
            num(vy),
            num(vw),
            num(vh)
        );
        if let Some(class) = &opts.class_name {
            let _ = write!(svg, " class=\"{class}\"");
        }
        svg.push('>');
        if !font_css.is_empty() {
            let safe = font_css.replace("]]>", "]]]]><![CDATA[>");
            let _ = write!(
                svg,
                "<style type=\"text/css\"><![CDATA[\n{safe}\n]]></style>"
            );
        }
        if !self.defs.is_empty() {
            svg.push_str("<defs>");
            svg.push_str(&self.defs);
            svg.push_str("</defs>");
        }
        svg.push_str(&self.body);
        svg.push_str("</svg>");
        svg
    }
}

/// Text as XML: only the three characters that could end the element early.
pub fn push_escaped(out: &mut String, text: &str) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
}

impl NativeDevice for SvgDevice {
    fn fill_path(
        &mut self,
        path: &Path,
        even_odd: bool,
        ctm: Matrix,
        cs: &Colorspace,
        color: &[f32],
        alpha: f32,
        cp: ColorParams,
    ) {
        let mut paint = format!(" fill=\"{}\"", rgb(cs, color, cp));
        if let Some(o) = opacity(alpha) {
            let _ = write!(paint, " fill-opacity=\"{o}\"");
        }
        self.path_element(path, &ctm, &paint, even_odd, None);
    }

    fn stroke_path(
        &mut self,
        path: &Path,
        stroke: &StrokeState,
        ctm: Matrix,
        cs: &Colorspace,
        color: &[f32],
        alpha: f32,
        cp: ColorParams,
    ) {
        let mut paint = format!(" stroke=\"{}\"", rgb(cs, color, cp));
        if let Some(o) = opacity(alpha) {
            let _ = write!(paint, " stroke-opacity=\"{o}\"");
        }
        self.path_element(path, &ctm, &paint, false, Some((stroke, stroke.line_width())));
    }

    fn clip_path(&mut self, path: &Path, even_odd: bool, ctm: Matrix, _scissor: Rect) {
        self.clip(path, even_odd, &ctm);
    }

    fn fill_text(
        &mut self,
        text: &Text,
        ctm: Matrix,
        cs: &Colorspace,
        color: &[f32],
        alpha: f32,
        cp: ColorParams,
    ) {
        let mut paint = format!(" fill=\"{}\"", rgb(cs, color, cp));
        if let Some(o) = opacity(alpha) {
            let _ = write!(paint, " fill-opacity=\"{o}\"");
        }
        self.text(text, &ctm, &paint, None);
    }

    fn stroke_text(
        &mut self,
        text: &Text,
        stroke: &StrokeState,
        ctm: Matrix,
        cs: &Colorspace,
        color: &[f32],
        alpha: f32,
        cp: ColorParams,
    ) {
        let mut paint = format!(" stroke=\"{}\"", rgb(cs, color, cp));
        if let Some(o) = opacity(alpha) {
            let _ = write!(paint, " stroke-opacity=\"{o}\"");
        }
        self.text(text, &ctm, &paint, Some(stroke));
    }

    fn clip_text(&mut self, text: &Text, ctm: Matrix, _scissor: Rect) {
        let (paths, count) = self.glyph_paths(text, &ctm, None);
        if count == 0 {
            // A clip with no glyphs clips everything away, and an empty
            // `<clipPath>` is not something every renderer agrees on. The stack
            // stays paired and nothing is written.
            self.open.push(Open::Empty);
            return;
        }
        let id = self.next_id_of("clip");
        let _ = write!(self.defs, "<clipPath id=\"{id}\">{paths}</clipPath>");
        self.emit(&format!("<g clip-path=\"url(#{id})\">"));
        self.open.push(Open::Clip);
    }

    fn clip_stroke_text(
        &mut self,
        text: &Text,
        stroke: &StrokeState,
        ctm: Matrix,
        _scissor: Rect,
    ) {
        let (paths, count) = self.glyph_paths(text, &ctm, Some(stroke));
        if count == 0 {
            self.open.push(Open::Empty);
            return;
        }
        // A `<clipPath>` fills its children and can never stroke one, so a
        // stroked text clip is a mask with the stroke drawn white in it: the
        // same geometry by the only route SVG has.
        let id = self.next_id_of("mask");
        let (w, h) = self.page;
        self.begin_defs();
        let _ = write!(
            self.defs,
            "<mask id=\"{id}\" mask-type=\"alpha\" maskUnits=\"userSpaceOnUse\" \
             maskContentUnits=\"userSpaceOnUse\" x=\"0\" y=\"0\" width=\"{}\" height=\"{}\">\
             {paths}</mask>",
            num(w),
            num(h)
        );
        self.end_defs();
        self.emit(&format!("<g mask=\"url(#{id})\">"));
        self.open.push(Open::Clip);
    }

    fn clip_stroke_path(
        &mut self,
        path: &Path,
        stroke: &StrokeState,
        ctm: Matrix,
        _scissor: Rect,
    ) {
        let d = path_data(path);
        if d.is_empty() {
            self.open.push(Open::Empty);
            return;
        }
        let id = self.next_id_of("mask");
        // The path is in user space, so its width is the page's own and no
        // scaling is needed. The region is the stroked path's own bound, which
        // is what MuPDF's SVG device uses too.
        let region = path
            .bounds(stroke, &ctm)
            .ok()
            .filter(|r| !r.is_empty() && !ffi::is_infinite(*r))
            .unwrap_or(Rect::new(0.0, 0.0, self.page.0, self.page.1));
        self.begin_defs();
        let _ = write!(
            self.defs,
            "<mask id=\"{id}\" mask-type=\"alpha\" maskUnits=\"userSpaceOnUse\" \
             maskContentUnits=\"userSpaceOnUse\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\">\
             <path transform=\"{}\" d=\"{d}\" fill=\"none\" stroke=\"#ffffff\"",
            num(region.x0),
            num(region.y0),
            num(region.width()),
            num(region.height()),
            matrix_attr(&ctm)
        );
        stroke_attrs(&mut self.defs, stroke, stroke.line_width());
        self.defs.push_str("/></mask>");
        self.end_defs();
        self.emit(&format!("<g mask=\"url(#{id})\">"));
        self.open.push(Open::Clip);
    }

    fn pop_clip(&mut self) {
        self.close_one();
    }

    fn begin_group(
        &mut self,
        _area: Rect,
        _cs: &Colorspace,
        _isolated: bool,
        _knockout: bool,
        blendmode: BlendMode,
        alpha: f32,
    ) {
        let mut attrs = String::new();
        if let Some(o) = opacity(alpha) {
            let _ = write!(attrs, " opacity=\"{o}\"");
        }
        if let Some(name) = blend_mode(blendmode) {
            let _ = write!(attrs, " style=\"mix-blend-mode:{name}\"");
        }
        self.emit(&format!("<g{attrs}>"));
        self.open.push(Open::Group);
    }

    fn end_group(&mut self) {
        self.close_one();
    }

    fn begin_mask(
        &mut self,
        _area: Rect,
        luminosity: bool,
        _cs: &Colorspace,
        _color: &[f32],
        _cp: ColorParams,
    ) {
        let id = self.next_id();
        self.masks.push(SoftMask { id, luminosity });
        self.begin_defs();
        let name = self.id("mask", id);
        let (w, h) = self.page;
        let _ = write!(self.defs, "<g id=\"{name}_contents\">");
        // A luminosity mask is opaque white until the page says otherwise, an
        // alpha mask transparent; and SVG shrinks a mask that has nothing in it,
        // so either way the page is painted first. The contents are written as a
        // definition of their own rather than inside the `<mask>`, because the
        // mask element cannot be opened until its type is known and closed until
        // the second pass has been drawn.
        let paint = if luminosity {
            " fill=\"#ffffff\""
        } else {
            " fill-opacity=\"0\""
        };
        let _ = write!(
            self.defs,
            "<rect x=\"0\" y=\"0\" width=\"{}\" height=\"{}\"{paint}/>",
            num(w),
            num(h)
        );
    }

    fn end_mask(&mut self, f: &Function) {
        let Some(mask) = self.masks.pop() else {
            return;
        };
        self.flush_run();
        self.defs.push_str("</g>");
        let name = self.id("mask", mask.id);
        let filter = if ffi::has_function(f) {
            self.transfer_filter(&mask, f)
        } else {
            String::new()
        };
        let (w, h) = self.page;
        let kind = if mask.luminosity { "luminance" } else { "alpha" };
        let _ = write!(
            self.defs,
            "<mask id=\"{name}\" mask-type=\"{kind}\" maskUnits=\"userSpaceOnUse\" \
             maskContentUnits=\"userSpaceOnUse\" x=\"0\" y=\"0\" width=\"{}\" height=\"{}\">\
             <use xlink:href=\"#{name}_contents\"{filter}/></mask>",
            num(w),
            num(h)
        );
        self.in_defs = self.in_defs.saturating_sub(1);
        self.emit(&format!("<g mask=\"url(#{name})\">"));
        self.open.push(Open::Clip);
    }

    fn begin_tile(
        &mut self,
        area: Rect,
        view: Rect,
        x_step: f32,
        y_step: f32,
        ctm: Matrix,
        _id: Option<NonZero<i32>>,
        _doc_id: Option<NonZero<i32>>,
    ) -> Option<NonZero<i32>> {
        // MuPDF warns and uses one for a pattern that cannot repeat; a step of
        // zero would otherwise be an infinite loop here.
        let step = |s: f32| if s == 0.0 { 1.0 } else { s.abs() };
        let (x_step, y_step) = (step(x_step), step(y_step));
        let id = self.next_id();
        self.begin_defs();
        let name = self.id("pattern", id);
        // The tile is captured once and repeated by the `<pattern>`; the `<use>`
        // that puts it on the page is written when the tile ends.
        let _ = write!(self.defs, "<g id=\"{name}_tile\">");
        self.tiles.push(Tile {
            id,
            area,
            view,
            step: (x_step, y_step),
            ctm,
        });
        // Zero, so the interpreter draws the tile's contents into this device -
        // which is what a pattern needs. Anything else says the tile is already
        // cached and the contents are skipped.
        None
    }

    fn end_tile(&mut self) {
        let Some(tile) = self.tiles.pop() else {
            return;
        };
        self.flush_run();
        self.defs.push_str("</g>");
        let name = self.id("pattern", tile.id);
        let (sw, sh) = tile.step;
        let (vw, vh) = (tile.view.x1 - tile.view.x0, tile.view.y1 - tile.view.y0);

        // A step smaller than the tile means one repeat does not cover the
        // pattern cell, so the tile is drawn more than once inside it; a view
        // box that is not anchored at the origin needs a clip of its own.
        let clipped = tile.view.x0 > 0.0
            || sw < tile.view.x1
            || tile.view.y0 > 0.0
            || sh < tile.view.y1;
        let _ = write!(
            self.defs,
            "<pattern id=\"{name}\" patternUnits=\"userSpaceOnUse\" \
             patternContentUnits=\"userSpaceOnUse\" x=\"0\" y=\"0\" width=\"{}\" height=\"{}\">",
            num(sw),
            num(sh)
        );
        if clipped {
            let clip = self.next_id_of("clip");
            let _ = write!(
                self.defs,
                "<clipPath id=\"{clip}\"><path d=\"M{} {}L{} {}L{} {}L{} {}Z\"/></clipPath>\
                 <g clip-path=\"url(#{clip})\">",
                num(tile.view.x0),
                num(tile.view.y0),
                num(tile.view.x1),
                num(tile.view.y0),
                num(tile.view.x1),
                num(tile.view.y1),
                num(tile.view.x0),
                num(tile.view.y1)
            );
        }
        // The tile's contents were drawn with the pattern's own transform
        // already composed, so the repeats are placed in pattern space and the
        // group takes that transform back off.
        let inverse = tile.ctm.invert().unwrap_or(Matrix::IDENTITY);
        let _ = write!(self.defs, "<g transform=\"{}\">", matrix_attr(&inverse));
        let mut x = 0.0;
        while x > -vw {
            let mut y = 0.0;
            while y > -vh {
                let _ = write!(
                    self.defs,
                    "<use x=\"{}\" y=\"{}\" xlink:href=\"#{name}_tile\"/>",
                    num(x),
                    num(y)
                );
                y -= sh;
            }
            x -= sw;
        }
        self.defs.push_str("</g>");
        if clipped {
            self.defs.push_str("</g>");
        }
        self.defs.push_str("</pattern>");
        self.end_defs();

        // And the shape filled with it, in the pattern's own space - which is
        // the space the pattern's `userSpaceOnUse` units are read in.
        self.emit(&format!(
            "<rect transform=\"{}\" x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"url(#{name})\"/>",
            matrix_attr(&tile.ctm),
            num(tile.area.x0),
            num(tile.area.y0),
            num(tile.area.x1 - tile.area.x0),
            num(tile.area.y1 - tile.area.y0)
        ));
    }

    /// Invisible text: render mode 3, the way a scanned page carries the text a
    /// reader can select. Nothing is drawn, and nothing is written.
    ///
    /// MuPDF's own SVG device writes it as text with no opacity, but only in its
    /// text-as-text mode; the pipeline this replaces ran in text-as-path mode,
    /// where it wrote nothing either. What a reader searches and copies comes
    /// from the text device, not from the page's shapes.
    fn ignore_text(&mut self, _text: &Text, _ctm: Matrix) {}

    fn fill_shade(&mut self, shade: &Shade, ctm: Matrix, alpha: f32, cp: ColorParams) {
        if alpha == 0.0 {
            return;
        }
        // A gradient where SVG has one that means the same thing, MuPDF's own
        // rasterisation where it does not.
        let markup = self
            .shade_gradient(shade, &ctm, alpha, cp)
            .or_else(|| self.shade_raster(shade, &ctm, alpha, cp));
        if let Some(markup) = markup {
            self.stats.shades += 1;
            self.emit(&markup);
        }
    }

    fn fill_image(&mut self, img: &Image, ctm: Matrix, alpha: f32, _cp: ColorParams) {
        if alpha == 0.0 {
            return;
        }
        let (w, h) = (img.width(), img.height());
        if w == 0 || h == 0 {
            return;
        }
        let Some(uri) = ffi::image_data_uri(img) else {
            return;
        };
        // One user unit per pixel: the image is written at its own size and the
        // scale is what puts it back on the page, which is how MuPDF's own SVG
        // device places one. The `<image>` has no transform of its own, so its
        // width and height are read in the group's space.
        let local = Matrix::new_scale(1.0 / w as f32, 1.0 / h as f32) * ctm;
        let mut el = String::new();
        let _ = write!(el, "<g");
        if let Some(o) = opacity(alpha) {
            let _ = write!(el, " opacity=\"{o}\"");
        }
        let _ = write!(el, " transform=\"{}\">", matrix_attr(&local));
        let _ = write!(
            el,
            "<image width=\"{}\" height=\"{}\" xlink:href=\"{uri}\"/></g>",
            num(w as f32),
            num(h as f32),
        );
        self.stats.images += 1;
        self.emit(&el);
    }

    fn fill_image_mask(
        &mut self,
        img: &Image,
        ctm: Matrix,
        cs: &Colorspace,
        color: &[f32],
        alpha: f32,
        cp: ColorParams,
    ) {
        if alpha == 0.0 {
            return;
        }
        let (w, h) = (img.width(), img.height());
        if w == 0 || h == 0 {
            return;
        }
        let Some(uri) = ffi::image_data_uri(img) else {
            return;
        };
        let (w, h) = (w as f32, h as f32);
        let id = self.next_id_of("mask");
        // A stencil's coverage is the grey value of the pixels it decodes to,
        // which is what a luminance mask reads - and what SVG 1.1 defaults a
        // mask to, so this is MuPDF's shape as well as its meaning.
        let _ = write!(
            self.defs,
            "<mask id=\"{id}\" mask-type=\"luminance\" maskUnits=\"userSpaceOnUse\" \
             maskContentUnits=\"userSpaceOnUse\" x=\"0\" y=\"0\" width=\"{}\" height=\"{}\">\
             <image width=\"{}\" height=\"{}\" xlink:href=\"{uri}\"/></mask>",
            num(w),
            num(h),
            num(w),
            num(h),
        );
        let local = Matrix::new_scale(1.0 / w, 1.0 / h) * ctm;
        let mut el = String::new();
        let _ = write!(el, "<g transform=\"{}\">", matrix_attr(&local));
        let _ = write!(
            el,
            "<rect x=\"0\" y=\"0\" width=\"{}\" height=\"{}\" fill=\"{}\"",
            num(w),
            num(h),
            rgb(cs, color, cp)
        );
        if let Some(o) = opacity(alpha) {
            let _ = write!(el, " fill-opacity=\"{o}\"");
        }
        let _ = write!(el, " mask=\"url(#{id})\"/></g>");
        self.stats.images += 1;
        self.emit(&el);
    }

    fn clip_image_mask(&mut self, img: &Image, ctm: Matrix, _scissor: Rect) {
        let (w, h) = (img.width(), img.height());
        if w == 0 || h == 0 {
            self.open.push(Open::Empty);
            return;
        }
        let Some(uri) = ffi::image_data_uri(img) else {
            self.open.push(Open::Empty);
            return;
        };
        let (w, h) = (w as f32, h as f32);
        let id = self.next_id_of("mask");
        let (pw, ph) = self.page;
        // The mask is applied by a group with no transform of its own, so its
        // content units are page units and the image is placed by the same
        // transform the reference uses: the unit square, scaled to the image.
        let local = Matrix::new_scale(1.0 / w, 1.0 / h) * ctm;
        let _ = write!(
            self.defs,
            "<mask id=\"{id}\" mask-type=\"luminance\" maskUnits=\"userSpaceOnUse\" \
             maskContentUnits=\"userSpaceOnUse\" x=\"0\" y=\"0\" width=\"{}\" height=\"{}\">\
             <g transform=\"{}\"><image width=\"{}\" height=\"{}\" \
             xlink:href=\"{uri}\"/></g></mask>",
            num(pw),
            num(ph),
            matrix_attr(&local),
            num(w),
            num(h),
        );
        self.stats.images += 1;
        self.emit(&format!("<g mask=\"url(#{id})\">"));
        self.open.push(Open::Clip);
    }
}

impl SvgDevice {
    /// The glyphs of a text object as path elements, at the transform MuPDF gave
    /// each one, and how many there were.
    ///
    /// A clip cannot be written as `<text>`: the browser would clip with
    /// whatever face it actually got, and a clip is geometry. Outlines are the
    /// same shape whatever the font does, so the clip is always outlines.
    fn glyph_paths(
        &self,
        text: &Text,
        ctm: &Matrix,
        stroke: Option<&StrokeState>,
    ) -> (String, usize) {
        let mut out = String::new();
        let mut count = 0;
        for span in text.spans() {
            let font = span.font();
            let trm = span.trm();
            for item in span.items() {
                let gid = item.gid();
                if gid < 0 {
                    continue;
                }
                let Ok(Some(outline)) = font.outline_glyph(gid) else {
                    continue;
                };
                let d = path_data(&outline);
                if d.is_empty() {
                    continue;
                }
                let m = trm.clone() * Matrix::new_translate(item.x(), item.y()) * ctm.clone();
                let _ = write!(out, "<path transform=\"{}\" d=\"{d}\"", matrix_attr(&m));
                if let Some(state) = stroke {
                    // Em units, as in `text_outlines`.
                    let k = (m.a * m.d - m.b * m.c).abs().sqrt();
                    let width = if k > 0.0 {
                        state.line_width() / k
                    } else {
                        state.line_width()
                    };
                    out.push_str(" fill=\"none\" stroke=\"#ffffff\"");
                    stroke_attrs(&mut out, state, width);
                }
                out.push_str("/>");
                count += 1;
            }
        }
        (out, count)
    }

    /// A soft mask's transfer function as `feComponentTransfer`, written into the
    /// definitions, and the attribute that refers to it.
    ///
    /// MuPDF samples a transfer function at 256 points and so does this: the
    /// table is what `feComponentTransfer` takes, and 256 is the resolution the
    /// rest of MuPDF's shading and mask code works at.
    fn transfer_filter(&mut self, mask: &SoftMask, f: &Function) -> String {
        let mut values = String::new();
        for i in 0..256 {
            let v = ffi::transfer(f, i as f32 / 255.0);
            let _ = write!(values, "{} ", num(v));
        }
        let mut channels = String::new();
        if mask.luminosity {
            for channel in ["feFuncR", "feFuncG", "feFuncB"] {
                let _ = write!(channels, "<{channel} type=\"table\" tableValues=\"{values}\"/>");
            }
        } else {
            let _ = write!(channels, "<feFuncA type=\"table\" tableValues=\"{values}\"/>");
        }
        let name = self.id("tr", mask.id);
        let _ = write!(
            self.defs,
            "<filter id=\"{name}\"><feComponentTransfer>{channels}</feComponentTransfer></filter>"
        );
        format!(" filter=\"url(#{name})\"")
    }

    /// A shading as a real SVG gradient, when it is one SVG can express.
    ///
    /// An axial shading is a `linearGradient` and a radial one whose inner
    /// radius is zero is a `radialGradient`, exactly: the same two circles and
    /// the same ramp. Everything else - a colour lattice, a mesh, a radial band
    /// with a hole in it, a focal point outside its own circle - has no SVG 1.1
    /// equivalent and is rasterised instead, which is what MuPDF's own SVG
    /// device does with every shading there is.
    fn shade_gradient(
        &mut self,
        shade: &Shade,
        ctm: &Matrix,
        alpha: f32,
        cp: ColorParams,
    ) -> Option<String> {
        let kind = ffi::kind(shade);
        let circles = ffi::circles(shade);
        let ramp = ffi::ramp(shade, cp)?;
        let stops = gradient_stops(&ramp, circles.extend);
        let transform = matrix_attr(&ffi::matrix(shade));
        let id = self.next_id_of("grad");
        let body = match kind {
            ffi::Kind::Axial => {
                let [x0, y0, _] = circles.start;
                let [x1, y1, _] = circles.end;
                format!(
                    "<linearGradient id=\"{id}\" gradientUnits=\"userSpaceOnUse\" \
                     gradientTransform=\"{transform}\" x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" \
                     spreadMethod=\"pad\">{stops}</linearGradient>",
                    num(x0),
                    num(y0),
                    num(x1),
                    num(y1)
                )
            }
            ffi::Kind::Radial => {
                let [fx, fy, r0] = circles.start;
                let [cx, cy, r1] = circles.end;
                if r0 > 1e-4 || r1 <= 0.0 {
                    return None;
                }
                if ((fx - cx).powi(2) + (fy - cy).powi(2)).sqrt() >= r1 {
                    return None;
                }
                format!(
                    "<radialGradient id=\"{id}\" gradientUnits=\"userSpaceOnUse\" \
                     gradientTransform=\"{transform}\" cx=\"{}\" cy=\"{}\" r=\"{}\" \
                     fx=\"{}\" fy=\"{}\" spreadMethod=\"pad\">{stops}</radialGradient>",
                    num(cx),
                    num(cy),
                    num(r1),
                    num(fx),
                    num(fy)
                )
            }
            _ => return None,
        };
        self.defs.push_str(&body);

        // The area covered is the shading's own bound - which, for a shading
        // told to extend, is no bound at all. The page is then the only edge
        // there is, and the clip already in force is what really shapes it.
        let bound = ffi::bound(shade, &Matrix::IDENTITY);
        let region = if ffi::is_infinite(bound) {
            let page = Rect::new(0.0, 0.0, self.page.0, self.page.1);
            match ctm.invert() {
                Some(inverse) => page.transform(&inverse),
                None => page,
            }
        } else {
            bound
        };
        let mut el = String::new();
        let _ = write!(el, "<g");
        if let Some(o) = opacity(alpha) {
            let _ = write!(el, " opacity=\"{o}\"");
        }
        // The rectangle is in the shading's own space and the group carries the
        // page's transform, so the gradient's `gradientTransform` - the
        // shading's matrix - is the only transform between the two.
        let _ = write!(
            el,
            " transform=\"{}\"><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" \
             fill=\"url(#{id})\"/></g>",
            matrix_attr(ctm),
            num(region.x0),
            num(region.y0),
            num(region.width()),
            num(region.height())
        );
        Some(el)
    }

    /// A shading SVG has no gradient for, drawn by MuPDF into a pixmap and
    /// inlined as a PNG.
    ///
    /// MuPDF bounds the shading and clips it to the device scissor; the page is
    /// the part of that this device can see, and the clip in force is already in
    /// the markup. The result is MuPDF's own rendering of the mesh, at a finer
    /// resolution than its SVG device uses.
    fn shade_raster(
        &mut self,
        shade: &Shade,
        ctm: &Matrix,
        alpha: f32,
        cp: ColorParams,
    ) -> Option<String> {
        let page = Rect::new(0.0, 0.0, self.page.0, self.page.1);
        let visible = ffi::bound(shade, ctm).intersect(&page);
        if visible.is_empty() {
            return None;
        }
        let scale = SHADE_RASTER_SCALE;
        let bbox = IRect::new(
            (visible.x0 * scale).floor() as i32,
            (visible.y0 * scale).floor() as i32,
            (visible.x1 * scale).ceil() as i32,
            (visible.y1 * scale).ceil() as i32,
        );
        if bbox.is_empty() {
            return None;
        }
        let mut pixmap = Pixmap::new_with_rect(&Colorspace::device_rgb(), bbox, true).ok()?;
        pixmap.clear().ok()?;
        {
            let device = Device::from_pixmap(&pixmap).ok()?;
            // A draw device renders into the pixmap's own coordinates, so a
            // post-scale is all it takes to land the shading there: the scale
            // goes on the *outside* of the page transform, so that a device
            // coordinate is the page's own multiplied by it. Scaling the other
            // way round scales the page's space instead, which moves everything
            // by the page height - MuPDF's own `fz_post_scale`. The pixmap's
            // origin is MuPDF's business, not the transform's.
            let into_pixels = ctm.clone() * Matrix::new_scale(scale, scale);
            device.fill_shade(shade, &into_pixels, 1.0, cp).ok()?;
        }
        let mut png = Vec::new();
        pixmap.write_to(&mut png, mupdf::ImageFormat::PNG).ok()?;
        let mut el = String::new();
        let _ = write!(el, "<g");
        if let Some(o) = opacity(alpha) {
            let _ = write!(el, " opacity=\"{o}\"");
        }
        let _ = write!(
            el,
            "><image x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" \
             xlink:href=\"data:image/png;base64,{}\"/></g>",
            num(bbox.x0 as f32 / scale),
            num(bbox.y0 as f32 / scale),
            num(bbox.width() as f32 / scale),
            num(bbox.height() as f32 / scale),
            base64(&png)
        );
        Some(el)
    }
}

/// The stops of a gradient, from the shading's own colour table.
///
/// MuPDF samples the shading function into 256 colours, and the stops are the
/// fewest that stay within one 8-bit step of that table. A shading whose
/// function is the linear one PDF shadings almost always carry collapses to its
/// two endpoint colours - which is exactly what MuPDF's own rasteriser
/// interpolates between - while a curved one keeps the shape PDF gives it
/// instead of the straight line.
///
/// A side that was not told to extend is not painted beyond, and a stop that
/// fades to nothing over a fraction of a pixel is how SVG says that.
fn gradient_stops(ramp: &[[f32; 3]], extend: [bool; 2]) -> String {
    let samples: Vec<[u8; 3]> = ramp.iter().map(|c| quantise(*c)).collect();
    let last = samples.len().saturating_sub(1);
    if last == 0 {
        return format!("<stop offset=\"0\" stop-color=\"{}\"/>", hex(samples[0]));
    }
    let offset = |i: usize| num(i as f32 / last as f32);
    let mut out = String::new();
    if extend[0] {
        let _ = write!(out, "<stop offset=\"0\" stop-color=\"{}\"/>", hex(samples[0]));
    } else {
        let _ = write!(
            out,
            "<stop offset=\"0\" stop-color=\"{}\" stop-opacity=\"0\"/>",
            hex(samples[0])
        );
        let _ = write!(
            out,
            "<stop offset=\"{}\" stop-color=\"{}\"/>",
            num(STOP_EPSILON),
            hex(samples[0])
        );
    }

    let mut from = 0;
    let mut at = 1;
    while at < last {
        if !fits_line(&samples, from, at + 1) {
            let _ = write!(
                out,
                "<stop offset=\"{}\" stop-color=\"{}\"/>",
                offset(at),
                hex(samples[at])
            );
            from = at;
        }
        at += 1;
    }

    if extend[1] {
        let _ = write!(out, "<stop offset=\"1\" stop-color=\"{}\"/>", hex(samples[last]));
    } else {
        let _ = write!(
            out,
            "<stop offset=\"{}\" stop-color=\"{}\"/>",
            num(1.0 - STOP_EPSILON),
            hex(samples[last])
        );
        let _ = write!(
            out,
            "<stop offset=\"1\" stop-color=\"{}\" stop-opacity=\"0\"/>",
            hex(samples[last])
        );
    }
    out
}

/// Whether every sample between two of them lies within one 8-bit step of the
/// straight line joining those two.
fn fits_line(samples: &[[u8; 3]], from: usize, to: usize) -> bool {
    if to <= from + 1 {
        return true;
    }
    let span = (to - from) as f32;
    for i in (from + 1)..to {
        let t = (i - from) as f32 / span;
        for channel in 0..3 {
            let a = samples[from][channel] as f32;
            let b = samples[to][channel] as f32;
            let line = a + (b - a) * t;
            if (samples[i][channel] as f32 - line).abs() > 1.0 {
                return false;
            }
        }
    }
    true
}

/// A colour as the 8-bit sRGB a browser reads.
fn quantise(color: [f32; 3]) -> [u8; 3] {
    let channel = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    [channel(color[0]), channel(color[1]), channel(color[2])]
}

/// A colour as `#rrggbb`.
fn hex(color: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", color[0], color[1], color[2])
}

/// Render one page to SVG, in one pass, with MuPDF's own interpreter.
/// One page's SVG, and the box a host should lay it out in.
///
/// `width`/`height` are the crop's when there is one and the page's otherwise -
/// which is what a viewer positions pages by, so it is the window's size and not
/// the page's.
pub struct RenderedPage {
    pub svg: String,
    pub width: f32,
    pub height: f32,
    pub stats: PageStats,
}

pub fn render_page_svg(
    doc: &Document,
    page_no: i32,
    opts: &RenderOptions,
    plan: Rc<Plan>,
) -> Result<RenderedPage, Error> {
    let plan = plan;
    let page = mupdf::pdf::PdfPage::try_from(doc.load_page(page_no)?)?;
    let bounds = page.bounds()?;
    let width = bounds.x1 - bounds.x0;
    let height = bounds.y1 - bounds.y0;

    // The text device runs first: a space is anchored to the character that
    // follows it, so where the spaces go has to be known before the glyphs are
    // written.
    let chars = crate::text::page_chars(&page)?;
    let marks = crate::text::space_marks(&chars);
    let fonts = plan.page_entries(&page);

    let device = Rc::new(RefCell::new(SvgDevice::new(
        Rc::clone(&plan),
        Rc::new(fonts),
        Rc::new(CharGrid::new(&chars)),
        &marks,
        (width, height),
        opts,
    )));
    {
        let target = mupdf::Device::from_native(device.clone())?;
        page.run(&target, &Matrix::IDENTITY)?;
    }

    let mut device = match Rc::try_unwrap(device) {
        Ok(cell) => cell.into_inner(),
        Err(shared) => shared.borrow_mut().take(),
    };
    // The stats are read after `finish`, not before: `finish` flushes the page's
    // last run - the one that counts towards `runs` and `faded` - and works out
    // how many faces the page drew with. Read first, the last run was missing
    // and `fonts` was always 0.
    let svg = device.finish(width, height, opts);
    let stats = device.stats();
    let (vw, vh) = match opts.view_box {
        Some((_, _, w, h)) => (w, h),
        None => (width, height),
    };
    Ok(RenderedPage {
        svg,
        width: vw,
        height: vh,
        stats,
    })
}

impl SvgDevice {
    /// Take everything out of a device that was shared, for the case where the
    /// MuPDF side has not let go of its handle yet.
    fn take(&mut self) -> Self {
        Self {
            plan: Rc::clone(&self.plan),
            fonts: Rc::clone(&self.fonts),
            chars: Rc::clone(&self.chars),
            marks: std::mem::take(&mut self.marks),
            mark_cells: std::mem::take(&mut self.mark_cells),
            placed: std::mem::take(&mut self.placed),
            run: self.run.take(),
            pending: std::mem::take(&mut self.pending),
            run_gap: self.run_gap,
            used: std::mem::take(&mut self.used),
            page: self.page,
            prefix: std::mem::take(&mut self.prefix),
            bionic: self.bionic,
            in_defs: self.in_defs,
            masks: std::mem::take(&mut self.masks),
            tiles: std::mem::take(&mut self.tiles),
            body: std::mem::take(&mut self.body),
            defs: std::mem::take(&mut self.defs),
            open: std::mem::take(&mut self.open),
            ids: self.ids,
            stats: self.stats,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A device with nothing in it, for the parts that do not need a page.
    fn device(prefix: &str) -> SvgDevice {
        device_with(prefix, false)
    }

    /// The same, with bionic reading on at the default strength.
    fn device_with(prefix: &str, bionic: bool) -> SvgDevice {
        let opts = RenderOptions {
            id_prefix: prefix.to_string(),
            bionic,
            ..Default::default()
        };
        SvgDevice::new(
            Rc::new(Plan::new()),
            Rc::new(HashMap::new()),
            Rc::new(CharGrid::new(&[])),
            &[],
            (400.0, 300.0),
            &opts,
        )
    }

    /// A run of one character per item, each at its own offset, for the parts of
    /// the writer that only need positions and text.
    fn run_of(text: &str) -> Run {
        run_with(
            text.chars()
                .enumerate()
                .map(|(i, c)| RunItem {
                    x: i as f32,
                    y: 0.0,
                    text: c.to_string(),
                    len: 1,
                })
                .collect(),
        )
    }

    /// The same, with the items spelled out: a glyph can stand for several
    /// letters - a ligature - and then it is one outline with one position.
    fn run_with(items: Vec<RunItem>) -> Run {
        Run {
            entry: 0,
            family: "test".into(),
            paint: " fill=\"#000000\"".into(),
            linear: (1.0, 0.0, 0.0, 1.0),
            items,
        }
    }

    /// Bionic reading cuts a run into the stretches `text-vide` marked: the
    /// fixation points at full strength, everything between them faded, and one
    /// position per character either way.
    #[test]
    fn bionic_fades_between_the_fixation_points() {
        let mut plain = device("");
        plain.write_run(&run_of("Hello, world!"));
        assert!(!plain.body.contains("fill-opacity"), "{}", plain.body);
        assert_eq!(plain.stats().faded, 0);

        let mut faded = device_with("", true);
        faded.write_run(&run_of("Hello, world!"));
        assert!(faded.body.contains(
            "<tspan x=\"0 1 2\" y=\"0 0 0\">Hel</tspan>\
             <tspan fill-opacity=\"0.5\" x=\"3 4 5 6\" y=\"0 0 0 0\">lo, </tspan>\
             <tspan x=\"7 8 9\" y=\"0 0 0\">wor</tspan>\
             <tspan fill-opacity=\"0.5\" x=\"10 11 12\" y=\"0 0 0\">ld!</tspan>"
        ), "{}", faded.body);
        assert_eq!(faded.stats().faded, 7);
    }

    /// A glyph that stands for several letters keeps its own `<tspan>` when the
    /// page is faded too, and takes the answer of the stretch its first letter is
    /// in: here `ffi` is inside `offi`, so it stays at full strength.
    #[test]
    fn bionic_leaves_a_ligature_its_own_tspan() {
        let mut device = device_with("", true);
        device.write_run(&run_with(vec![
            RunItem { x: 0.0, y: 0.0, text: "o".into(), len: 1 },
            RunItem { x: 1.0, y: 0.0, text: "ffi".into(), len: 3 },
            RunItem { x: 2.0, y: 0.0, text: "ce".into(), len: 2 },
        ]));
        assert!(device.body.contains(
            "<tspan x=\"0\" y=\"0\">o</tspan>\
             <tspan x=\"1\" y=\"0\">ffi</tspan>\
             <tspan fill-opacity=\"0.5\" x=\"2\" y=\"0\">ce</tspan>"
        ), "{}", device.body);
        assert_eq!(device.stats().faded, 1);
    }

    /// The strength is the caller's, not a constant: the same page can be drawn
    /// at any fade the reader asked for.
    #[test]
    fn bionic_draws_at_the_strength_it_is_given() {
        let opts = RenderOptions {
            bionic: true,
            bionic_dim: Some(0.2),
            ..Default::default()
        };
        let mut device = SvgDevice::new(
            Rc::new(Plan::new()),
            Rc::new(HashMap::new()),
            Rc::new(CharGrid::new(&[])),
            &[],
            (400.0, 300.0),
            &opts,
        );
        device.write_run(&run_of("Hello"));
        assert!(device.body.contains("fill-opacity=\"0.2\""), "{}", device.body);
    }

    /// An id from one page inlined into a host page must not collide with the
    /// same id from another, so every one of them carries the host's prefix.
    #[test]
    fn ids_carry_the_host_prefix() {
        let plain = device("");
        assert_eq!(plain.id("clip", 7), "clip_7");

        let mut prefixed = device("p3-");
        assert_eq!(prefixed.next_id_of("mask"), "p3-mask_1");
        assert_eq!(prefixed.next_id_of("grad"), "p3-grad_2");
        assert_eq!(prefixed.id("pattern", 9), "p3-pattern_9");
    }

    /// The ramp is sampled 256 times and written as fewest stops that stay
    /// within an 8-bit step of it: a straight ramp is its two ends, whatever
    /// the table's length.
    #[test]
    fn a_linear_ramp_is_two_stops() {
        let ramp: Vec<[f32; 3]> = (0..256)
            .map(|i| {
                let t = i as f32 / 255.0;
                [t, 0.0, 1.0 - t]
            })
            .collect();
        let stops = gradient_stops(&ramp, [true, true]);
        assert_eq!(stops.matches("<stop").count(), 2, "{stops}");
        assert!(stops.contains("stop-color=\"#0000ff\""), "{stops}");
        assert!(stops.contains("stop-color=\"#ff0000\""), "{stops}");
    }

    /// A curve is kept: the samples that a straight line would miss each get a
    /// stop of their own.
    #[test]
    fn a_curved_ramp_keeps_its_shape() {
        let ramp: Vec<[f32; 3]> = (0..256)
            .map(|i| {
                let t = i as f32 / 255.0;
                [t * t, 0.0, 0.0]
            })
            .collect();
        let stops = gradient_stops(&ramp, [true, true]);
        assert!(stops.matches("<stop").count() > 8, "{stops}");
    }

    /// A shading that was not told to extend is not painted beyond its ends, so
    /// the first and last stops fade to nothing.
    #[test]
    fn an_end_that_does_not_extend_fades_out() {
        let ramp = vec![[1.0, 0.0, 0.0], [0.0, 0.0, 1.0]];
        let open = gradient_stops(&ramp, [true, true]);
        assert_eq!(open.matches("stop-opacity").count(), 0, "{open}");

        let closed = gradient_stops(&ramp, [false, false]);
        assert_eq!(closed.matches("stop-opacity=\"0\"").count(), 2, "{closed}");
    }
}
