//! The raw MuPDF calls the safe binding does not reach.
//!
//! `mupdf` 0.8 covers the device protocol and little beyond it. `Shade` is a
//! handle with a `Drop` and no accessors at all; `Pixmap`, `Image`, `Function`
//! and `Context` keep their pointer private; and there is no binding for
//! `fz_convert_color`, `fz_eval_function` or `fz_bound_shade`. What a shading
//! *is* - its family, its two circles, its colour ramp, its own matrix - and what
//! a soft mask's transfer function does are exactly those pieces, so this module
//! reads the pointer out of the handle and asks MuPDF directly. It also holds the
//! image encoder, because the one MuPDF's own SVG device uses is not re-exported
//! either and writing another would be a second opinion about every photograph.
//!
//! Every handle read here is a newtype over a single non-null pointer - an
//! `Image` carries a `PhantomData` beside its pointer, which takes no space - so
//! the field sits at offset zero and the handle's bytes *are* the pointer. The
//! size and alignment assertions in the macro below fail the build if one of
//! them ever stops being one pointer wide, which is the whole of what those reads
//! rest on. Nothing here takes ownership: the handles stay MuPDF's and are
//! dropped by their owners in `mupdf`, never by this module.
//!
//! `fz_shade`'s own documentation says "do not access the members directly".
//! There is no other way to reach them from Rust, and the alternative is to leave
//! every shading and every soft mask unrendered, so the members are read - but
//! only in this file, and only through the accessors below.

use std::ptr;
use std::slice;

use mupdf::{ColorParams, Context, Function, Image, Matrix, Rect, Shade};

use mupdf_sys as sys;

/// Read the pointer out of a one-field handle.
macro_rules! handle_pointer {
    ($(#[$meta:meta])* $name:ident, $handle:ty, $raw:ty) => {
        const _: () = {
            assert!(std::mem::size_of::<$handle>() == std::mem::size_of::<$raw>());
            assert!(std::mem::align_of::<$handle>() == std::mem::align_of::<$raw>());
        };

        $(#[$meta])*
        fn $name(handle: &$handle) -> $raw {
            // SAFETY: `$handle` is exactly one pointer wide and aligned, checked
            // by the assertions above, so this reads that one pointer and no
            // other byte of the handle. The handle is alive for the length of
            // the borrow, and the pointer it holds is either null or one MuPDF
            // owns for at least as long.
            unsafe { *(handle as *const $handle).cast::<$raw>() }
        }
    };
}

handle_pointer!(
    /// The `fz_context` the `mupdf` crate is itself using.
    ///
    /// The crate's own context, not a second one: a colour converted here and a
    /// pixmap allocated there belong to the same context, which is the only way
    /// the two can be mixed safely.
    context,
    Context,
    *mut sys::fz_context
);

handle_pointer!(
    /// The `fz_shade` behind a `Shade`.
    shade_pointer,
    Shade,
    *mut sys::fz_shade
);

handle_pointer!(
    /// The `fz_function` behind a `Function`.
    function_pointer,
    Function,
    *mut sys::fz_function
);

handle_pointer!(
    /// The `fz_image` behind an `Image`.
    image_pointer,
    Image,
    *mut sys::fz_image
);

/// An image as the `data:` URI MuPDF's own SVG device would have written.
///
/// This is `fz_append_image_as_data_uri` itself rather than an encoder of our
/// own, and it is what makes an image here byte for byte the image MuPDF's SVG
/// writer would have emitted: a JPEG in grey or sRGB is passed through as it
/// stands - its EXIF orientation rewritten to none on the way, so a browser does
/// not rotate an image MuPDF has already rotated - a PNG is passed through, and
/// anything else is re-encoded, lossily for a lossy source. Re-encoding every
/// image as PNG instead costs more than an order of magnitude on a photograph.
///
/// A soft mask is not part of this: an image's mask arrives as a clip or a mask
/// of its own around the fill, never inside the colour data.
pub fn image_data_uri(image: &Image) -> Option<String> {
    let ctx = ctx();
    let buf = unsafe { sys::fz_new_buffer(ctx, 4096) };
    if buf.is_null() {
        return None;
    }
    let mut data: *mut u8 = ptr::null_mut();
    // SAFETY: both handles are live for the length of the call, and the buffer
    // is one MuPDF made. A malformed image makes this raise, which lands in the
    // `fz_try` of the device wrapper that called us - the buffer then leaks, one
    // per unreadable image, which is the price of not having a Rust `fz_try`.
    let len = unsafe {
        sys::fz_append_image_as_data_uri(ctx, buf, image_pointer(image));
        sys::fz_buffer_storage(ctx, buf, &mut data)
    };
    // SAFETY: `fz_buffer_storage` hands back the buffer's own bytes and how many
    // of them there are; the buffer lives until the drop below.
    let uri = if data.is_null() || len == 0 {
        None
    } else {
        let bytes = unsafe { slice::from_raw_parts(data, len) };
        let mut uri = String::from_utf8_lossy(bytes).into_owned();
        // The writer wraps the base64 payload every 72 characters. A newline
        // inside an XML attribute is a newline only until the parser normalises
        // it into a space, so the breaks are taken out here rather than left to
        // the parser's discretion - base64 does not care either way.
        uri.retain(|c| !c.is_ascii_whitespace());
        Some(uri)
    };
    unsafe { sys::fz_drop_buffer(ctx, buf) };
    uri
}

/// The context, for the calls below that need one.
fn ctx() -> *mut sys::fz_context {
    context(&Context::get())
}

/// The four shading families MuPDF's `type` field distinguishes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// PDF shading type 1: a colour lattice over two parameters. It is a picture
    /// rather than a ramp, and no SVG gradient can express it.
    Function,
    /// PDF shading type 2: an axial (linear) shading between two points.
    Axial,
    /// PDF shading type 3: a radial shading between two circles.
    Radial,
    /// PDF shading types 4 to 7: a Gouraud or lattice mesh.
    Mesh,
}

/// The two circles of an axial or radial shading, `(x, y, r)` each.
#[derive(Debug, Clone, Copy)]
pub struct Circles {
    pub start: [f32; 3],
    pub end: [f32; 3],
    /// Whether the shading continues past each end, padded with that end's
    /// colour. False means it stops there, and nothing is painted beyond - which
    /// SVG can only say with a stop that fades to nothing.
    pub extend: [bool; 2],
}

/// Which family a shading belongs to.
pub fn kind(shade: &Shade) -> Kind {
    let shade = shade_pointer(shade);
    // MuPDF's `type` is a plain int; the constants are an unsigned enum.
    match unsafe { (*shade).type_ as u32 } {
        sys::FZ_LINEAR => Kind::Axial,
        sys::FZ_RADIAL => Kind::Radial,
        sys::FZ_FUNCTION_BASED => Kind::Function,
        _ => Kind::Mesh,
    }
}

/// The two circles of an axial or radial shading.
pub fn circles(shade: &Shade) -> Circles {
    let shade = shade_pointer(shade);
    // SAFETY: `type` says this is one of the two families that carry `l_or_r`.
    let circles = unsafe { (*shade).u.l_or_r };
    Circles {
        start: circles.coords[0],
        end: circles.coords[1],
        extend: [circles.extend[0] != 0, circles.extend[1] != 0],
    }
}

/// The matrix from the shading's own space to the space the `ctm` maps from.
pub fn matrix(shade: &Shade) -> Matrix {
    let shade = shade_pointer(shade);
    let m = unsafe { (*shade).matrix };
    Matrix::new(m.a, m.b, m.c, m.d, m.e, m.f)
}

/// The shading's bound under a transform, through MuPDF's own `fz_bound_shade`.
///
/// Every family is bounded differently - a radial by its circles, a mesh by two
/// corners, a function-based shading by its lattice - and MuPDF already knows
/// how, so the answer is asked for rather than guessed at.
pub fn bound(shade: &Shade, ctm: &Matrix) -> Rect {
    let shade = shade_pointer(shade);
    let r = unsafe { sys::fz_bound_shade(ctx(), shade, ctm.clone().into()) };
    Rect::new(r.x0, r.y0, r.x1, r.y1)
}

/// Whether a bound is one of MuPDF's infinities: a shading told to extend has no
/// edge in that direction.
pub fn is_infinite(rect: Rect) -> bool {
    rect.x0 <= -2.0e9 || rect.y0 <= -2.0e9 || rect.x1 >= 2.0e9 || rect.y1 >= 2.0e9
}

/// The colour a shading paints under itself before its ramp, when it has one.
pub fn background(shade: &Shade, cp: ColorParams) -> Option<[f32; 3]> {
    let shade = shade_pointer(shade);
    if unsafe { (*shade).use_background } == 0 {
        return None;
    }
    let cs = unsafe { (*shade).colorspace };
    let n = colorspace_components(cs)?;
    // SAFETY: `background` holds `FZ_MAX_COLORS` floats, and a colorspace with
    // `n` components never has `n` above that.
    let color = unsafe { &(&(*shade).background)[..n] };
    Some(to_rgb(cs, color, cp))
}

/// The number of colour components a shading's colours are given in, if it has a
/// colourspace at all. A shading without one is a mask, not a picture.
pub fn components(shade: &Shade) -> Option<usize> {
    let shade = shade_pointer(shade);
    colorspace_components(unsafe { (*shade).colorspace })
}

/// The shading's colour ramp, sampled where MuPDF samples it.
///
/// `fz_shade.function` is a table of 256 samples across the shading's parameter,
/// one row of `function_stride` components per sample, already in the shading's
/// colourspace - so this is PDF's own definition of the ramp rather than an
/// interpolation of our own. `None` when the shading carries no table, which is
/// a shading that is one flat colour or none at all.
pub fn ramp(shade: &Shade, cp: ColorParams) -> Option<Vec<[f32; 3]>> {
    let shade = shade_pointer(shade);
    let stride = unsafe { (*shade).function_stride };
    let table = unsafe { (*shade).function };
    let cs = unsafe { (*shade).colorspace };
    if stride <= 0 || table.is_null() || cs.is_null() {
        return None;
    }
    let n = stride as usize;
    let samples = 256;
    let mut out = Vec::with_capacity(samples);
    for i in 0..samples {
        // SAFETY: MuPDF's contract is that `function` points at `256 *
        // function_stride` floats, so row `i` is inside the allocation.
        let row = unsafe { slice::from_raw_parts(table.add(i * n), n) };
        out.push(to_rgb(cs, row, cp));
    }
    Some(out)
}

/// Whether MuPDF handed over a transfer function at all.
///
/// The `end_mask` shim in `mupdf` builds a `Function` around a pointer that is
/// null whenever the page has no transfer function, so the null test has to be
/// made on the pointer itself.
pub fn has_function(function: &Function) -> bool {
    !function_pointer(function).is_null()
}

/// One sample of a mask's transfer function.
pub fn transfer(function: &Function, t: f32) -> f32 {
    let function = function_pointer(function);
    if function.is_null() {
        return t;
    }
    let mut out = 0.0f32;
    // SAFETY: `function` is non-null and MuPDF's own evaluation, so the input
    // and output lengths are ours to choose; the function takes one input here
    // because a mask transfer function is one-dimensional.
    unsafe { sys::fz_eval_function(ctx(), function, &t, 1, &mut out, 1) };
    out
}

/// A colour in one colourspace as sRGB, through MuPDF's own conversion.
///
/// The same route `Colorspace::convert_color` takes, for a colourspace that
/// arrives as a raw pointer because it belongs to a shading rather than to a
/// device callback.
fn to_rgb(cs: *mut sys::fz_colorspace, color: &[f32], cp: ColorParams) -> [f32; 3] {
    if cs.is_null() {
        return [0.0, 0.0, 0.0];
    }
    let ctx = ctx();
    let mut out = [0.0f32; 3];
    // SAFETY: `cs` is a live colourspace owned by the shading, `color` holds at
    // least as many components as it has, `out` holds the three that device RGB
    // has, and the intermediate colourspace is deliberately none.
    unsafe {
        sys::fz_convert_color(
            ctx,
            cs,
            color.as_ptr(),
            sys::fz_device_rgb(ctx),
            out.as_mut_ptr(),
            ptr::null_mut(),
            cp.into(),
        );
    }
    out
}

/// How many colour components a colourspace has, or none when there is not one.
fn colorspace_components(cs: *mut sys::fz_colorspace) -> Option<usize> {
    if cs.is_null() {
        return None;
    }
    Some(unsafe { sys::fz_colorspace_n(ctx(), cs) } as usize)
}
