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

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt::Write as _;
use std::rc::Rc;
use std::sync::OnceLock;

use mupdf::{
    BlendMode, ColorParams, Colorspace, Document, Error, Image, Matrix, NativeDevice, Path,
    PathWalker, Rect, Shade, StrokeState, Text,
};

use crate::font::plan::Plan;
use crate::text::{is_simple_code, CharGrid, SpaceKind, SpaceMark, ANCHOR_EPSILON};

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
    /// `@font-face` rules embedded in this page.
    pub fonts: usize,
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
    let c = |i: usize| -> u8 {
        let v = converted.get(i).copied().unwrap_or(0.0);
        (v.clamp(0.0, 1.0) * 255.0).round() as u8
    };
    format!("#{:02x}{:02x}{:02x}", c(0), c(1), c(2))
}

fn opacity(alpha: f32) -> Option<String> {
    if alpha >= 1.0 {
        None
    } else {
        Some(num(alpha.max(0.0)))
    }
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

    /// The `@font-face` rules for the faces this page named.
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
        } else {
            self.body.push_str(text);
        }
    }

    /// A path element, with the transform MuPDF handed us and the paint the
    /// caller asked for. `stroke` is the whole stroke state when this is a
    /// stroke, and None when it is a fill.
    fn path_element(
        &mut self,
        path: &Path,
        ctm: &Matrix,
        paint: &str,
        even_odd: bool,
        stroke: Option<&StrokeState>,
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
        if let Some(state) = stroke {
            let _ = write!(
                el,
                " fill=\"none\" stroke-width=\"{}\"",
                num(state.line_width())
            );
            if state.line_join() != mupdf::LineJoin::Miter {
                let _ = write!(el, " stroke-linejoin=\"{}\"", join_name(state.line_join()));
            }
            if state.miter_limit() != 10.0 {
                let _ = write!(el, " stroke-miterlimit=\"{}\"", num(state.miter_limit()));
            }
            let dashes = state.dashes();
            if !dashes.is_empty() {
                let list: Vec<String> = dashes.iter().map(|d| num(*d)).collect();
                let _ = write!(el, " stroke-dasharray=\"{}\"", list.join(" "));
            }
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
        let id = self.next_id();
        let _ = write!(
            self.defs,
            "<clipPath id=\"clip_{id}\"><path transform=\"{}\" d=\"{}\"",
            matrix_attr(ctm),
            d
        );
        if even_odd {
            self.defs.push_str(" clip-rule=\"evenodd\"");
        }
        self.defs.push_str("/></clipPath>");
        self.emit(&format!("<g clip-path=\"url(#clip_{id})\">"));
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
            self.body.push_str(&self.pending);
            self.pending.clear();
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

        let mut xs = Vec::with_capacity(run.items.len());
        let mut ys = Vec::with_capacity(run.items.len());
        let mut groups: Vec<Vec<usize>> = Vec::new();
        let mut group: Vec<usize> = Vec::new();
        for (i, item) in run.items.iter().enumerate() {
            xs.push(num((kd * item.x - kc * item.y) / det));
            ys.push(num((-kb * item.x + ka * item.y) / det));
            // A glyph that stands for several characters gets a `<tspan>` of its
            // own: a shaper only joins letters it lays out together, and with a
            // position per character the browser would draw `fi` as an `f` and an
            // `i`, which is not what the page drew.
            if item.len > 1 {
                if !group.is_empty() {
                    groups.push(std::mem::take(&mut group));
                }
                groups.push(vec![i]);
            } else {
                group.push(i);
            }
        }
        if !group.is_empty() {
            groups.push(group);
        }

        let _ = write!(
            self.body,
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
        for indices in &groups {
            let x: Vec<&str> = indices.iter().map(|i| xs[*i].as_str()).collect();
            let y: Vec<&str> = indices.iter().map(|i| ys[*i].as_str()).collect();
            let _ = write!(self.body, "<tspan x=\"{}\" y=\"{}\">", x.join(" "), y.join(" "));
            for i in indices {
                push_escaped(&mut self.body, &run.items[*i].text);
            }
            self.body.push_str("</tspan>");
        }
        self.body.push_str("</text>");
        self.stats.runs += 1;
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
        let embedded = if opts.embed_fonts {
            self.font_css()
        } else {
            String::new()
        };
        let font_css = embedded.as_str();
        let mut svg = String::with_capacity(self.body.len() + self.defs.len() + 512);
        svg.push_str(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" \
             version=\"1.1\"",
        );
        if opts.responsive {
            let _ = write!(svg, " preserveAspectRatio=\"xMidYMid meet\" width=\"100%\" height=\"100%\"");
        } else {
            let _ = write!(svg, " width=\"{}\" height=\"{}\"", num(width), num(height));
        }
        let _ = write!(svg, " viewBox=\"0 0 {} {}\"", num(width), num(height));
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
        self.path_element(path, &ctm, &paint, false, Some(stroke));
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

    fn clip_text(&mut self, _text: &Text, _ctm: Matrix, _scissor: Rect) {
        // TODO: a clipping text object clips with its glyph outlines, which means
        // a `<clipPath>` holding every one of them. Until that is here the stack
        // is kept straight and nothing is written: a group with no content would
        // clip nothing, and the text inside it is written as usual.
        self.open.push(Open::Empty);
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
        _luminosity: bool,
        _cs: &Colorspace,
        _color: &[f32],
        _cp: ColorParams,
    ) {
        // TODO: a luminosity mask is a second pass into a `<mask>`; until it is
        // here the group's content is drawn unmasked, which is the visible part.
    }

    fn end_mask(&mut self, _f: &mupdf::Function) {}

    fn fill_shade(&mut self, _shade: &Shade, _ctm: Matrix, _alpha: f32, _cp: ColorParams) {
        // TODO: axial and radial shadings become real SVG gradients here.
    }

    fn fill_image(&mut self, _img: &Image, _ctm: Matrix, _alpha: f32, _cp: ColorParams) {
        // TODO: images are emitted as PNG data URIs (the pixels MuPDF decoded,
        // re-encoded here) with any soft mask as a `<mask>`.
    }
}

/// Render one page to SVG, in one pass, with MuPDF's own interpreter.
pub fn render_page_svg(
    doc: &Document,
    page_no: i32,
    opts: &RenderOptions,
    plan: Rc<Plan>,
) -> Result<(String, PageStats), Error> {
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
    )));
    {
        let target = mupdf::Device::from_native(device.clone())?;
        page.run(&target, &Matrix::IDENTITY)?;
    }

    let mut device = match Rc::try_unwrap(device) {
        Ok(cell) => cell.into_inner(),
        Err(shared) => shared.borrow_mut().take(),
    };
    let stats = device.stats();
    let svg = device.finish(width, height, opts);
    Ok((svg, stats))
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
            body: std::mem::take(&mut self.body),
            defs: std::mem::take(&mut self.defs),
            open: std::mem::take(&mut self.open),
            ids: self.ids,
            stats: self.stats,
        }
    }
}
