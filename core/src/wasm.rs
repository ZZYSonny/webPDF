//! The whole surface a browser host is given.
//!
//! The core is a Rust library with Rust types in it, and a browser has none of
//! those. This module is the narrow waist between them: a handful of
//! `extern "C"` functions, over integers and byte ranges, that a page drives
//! through Emscripten's generated glue. Everything a browser has to know about a
//! PDF it reads out of the data these return.
//!
//! # The shape of a call
//!
//! A call is one synchronous function. Its arguments are the document it is about
//! and, where it needs text, a `(pointer, length)` pair into wasm memory; its
//! answer is written into one buffer owned by this module and read back through
//! [`wpdf_out_ptr`] and the return value. The answer is a frame:
//!
//! ```text
//! [u32 header length, little endian][header JSON][payload bytes]
//! ```
//!
//! The header says what the payload is and carries everything that is not a blob:
//! a crop box, a page's links, a render's statistics. The payload is the blob
//! itself - an SVG, a stylesheet, a written-out PDF - kept out of the JSON so that
//! a quarter of a megabyte of markup does not have to be escaped twice. A failure
//! is a header with an `error` in it and no payload; nothing here returns an error
//! code, because the length is the only thing a caller can act on anyway.
//!
//! # Why not `wasm-bindgen`
//!
//! MuPDF is C, and its error handling is `setjmp`/`longjmp`, which only
//! Emscripten's runtime provides. So the module has to be linked by `emcc` and
//! started by `emcc`'s glue, and a second, unrelated binding layer on top of that
//! would only be another thing that has to agree about memory. The functions
//! below are the same ones the probe binary calls, and the demo's `engine.ts` is
//! the only code that reads the frame.

use std::cell::RefCell;
use std::collections::HashMap;
use std::slice;

use crate::crop;
use crate::info;
use crate::links::links_json;
use crate::svg::RenderOptions;
use crate::Core;

thread_local! {
    /// Everything the open documents and the last answer live in.
    ///
    /// One thread, one document set: wasm without threads has exactly one, and a
    /// `Core` holds MuPDF handles that may only be used from the one they were
    /// made on.
    static STATE: RefCell<State> = RefCell::new(State::new());
}

struct State {
    docs: HashMap<u32, Core>,
    next_id: u32,
    /// The bytes [`wpdf_out_ptr`] hands back, refilled by every call.
    out: Vec<u8>,
}

impl State {
    fn new() -> Self {
        Self {
            docs: HashMap::new(),
            next_id: 1,
            out: Vec::new(),
        }
    }
}

/* --------------------------------------------------------------- the frame */

/// Put `header` and `payload` in the output buffer and return the frame's length.
fn reply(header: &str, payload: &[u8]) -> i32 {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        let mut out = Vec::with_capacity(4 + header.len() + payload.len());
        out.extend_from_slice(&(header.len() as u32).to_le_bytes());
        out.extend_from_slice(header.as_bytes());
        out.extend_from_slice(payload);
        let len = out.len() as i32;
        state.out = out;
        len
    })
}

/// A failure, as the one kind of frame a caller has to look inside to notice.
fn fail(message: impl std::fmt::Display) -> i32 {
    reply(
        &format!("{{\"error\":{}}}", crate::json::quote(&message.to_string())),
        &[],
    )
}

/// A call's body, with the state borrow and the error frame wrapped around it.
fn call<F: FnOnce(&mut State) -> Result<(String, Vec<u8>), String>>(body: F) -> i32 {
    let result = STATE.with(|state| {
        let mut state = state.borrow_mut();
        body(&mut state)
    });
    match result {
        Ok((header, payload)) => reply(&header, &payload),
        Err(error) => fail(error),
    }
}

/* ------------------------------------------------------------------ inputs */

/// A `(pointer, length)` pair as a string.
///
/// # Safety
///
/// The caller must have put `len` valid bytes at `ptr` - which is what the glue's
/// `stringToUTF8` into a `_malloc` block does - and must not free them until the
/// call returns.
unsafe fn text(ptr: *const u8, len: usize) -> Result<String, String> {
    if len == 0 {
        return Ok(String::new());
    }
    if ptr.is_null() {
        return Err("a null string".into());
    }
    // SAFETY: the caller's contract, above.
    let bytes = unsafe { slice::from_raw_parts(ptr, len) };
    std::str::from_utf8(bytes)
        .map(str::to_string)
        .map_err(|error| format!("the argument is not UTF-8: {error}"))
}

/// A `(pointer, length)` pair as bytes.
///
/// # Safety
///
/// As [`text`].
unsafe fn blob(ptr: *const u8, len: usize) -> Result<Vec<u8>, String> {
    if len == 0 {
        return Ok(Vec::new());
    }
    if ptr.is_null() {
        return Err("a null buffer".into());
    }
    // SAFETY: the caller's contract, above.
    Ok(unsafe { slice::from_raw_parts(ptr, len) }.to_vec())
}

/* ---------------------------------------------------------------- the calls */

/// Which of the render options a caller set, as bits.
mod flag {
    pub const RESPONSIVE: u32 = 1;
    pub const EMBED_FONTS: u32 = 2;
    pub const BIONIC: u32 = 4;
    pub const LINKS: u32 = 8;
    /// A crop follows in the four numbers after the flags.
    pub const CROP: u32 = 16;
}

/// Open a PDF and read what it says about itself.
///
/// The answer's header carries the document's id and its info; there is no
/// payload. The document stays open until [`wpdf_close`].
///
/// # Safety
///
/// `bytes` must point at `len` readable bytes for the length of the call.
#[no_mangle]
pub unsafe extern "C" fn wpdf_open(bytes: *const u8, len: usize) -> i32 {
    let data = match unsafe { blob(bytes, len) } {
        Ok(data) => data,
        Err(error) => return fail(error),
    };
    call(|state| {
        let mut core = Core::open(&data, "application/pdf").map_err(|error| error.to_string())?;
        // A document that needs a password is opened anyway: the host has to be
        // able to ask for one, and asking means having something to ask about.
        let id = state.next_id;
        state.next_id += 1;
        let _ = core.plan_start();
        state.docs.insert(id, core);
        let core = &state.docs[&id];
        Ok((
            format!("{{\"id\":{id},\"info\":{}}}", info::to_json(core.info())),
            Vec::new(),
        ))
    })
}

/// Try a password on a locked document.
///
/// # Safety
///
/// As [`wpdf_open`], for the string.
#[no_mangle]
pub unsafe extern "C" fn wpdf_password(id: u32, ptr: *const u8, len: usize) -> i32 {
    let password = match unsafe { text(ptr, len) } {
        Ok(password) => password,
        Err(error) => return fail(error),
    };
    call(|state| {
        let core = state.docs.get_mut(&id).ok_or("no such document")?;
        let ok = core.authenticate(&password).map_err(|error| error.to_string())?;
        let info = info::to_json(core.info());
        Ok((format!("{{\"ok\":{ok},\"info\":{info}}}"), Vec::new()))
    })
}

/// Forget a document and everything read out of it.
#[no_mangle]
pub extern "C" fn wpdf_close(id: u32) -> i32 {
    call(|state| {
        state.docs.remove(&id);
        Ok(("{}".to_string(), Vec::new()))
    })
}

/// The document's info again, for a host that wants it after a password.
#[no_mangle]
pub extern "C" fn wpdf_info(id: u32) -> i32 {
    call(|state| {
        let core = state.docs.get(&id).ok_or("no such document")?;
        Ok((info::to_json(core.info()), Vec::new()))
    })
}

/// Walk up to `pages` more pages of the font plan.
///
/// `pages` of zero or less walks all that are left. The answer says how far it
/// got, so a host can paint a progress strip and hand the thread back between
/// calls - which is the only reason the walk is in pieces at all.
#[no_mangle]
pub extern "C" fn wpdf_plan(id: u32, pages: i32) -> i32 {
    call(|state| {
        let core = state.docs.get_mut(&id).ok_or("no such document")?;
        let done = core.plan_step(pages).map_err(|error| error.to_string())?;
        let (walked, total) = core.plan_progress();
        Ok((
            format!("{{\"done\":{done},\"walked\":{walked},\"total\":{total}}}"),
            Vec::new(),
        ))
    })
}

/// Every `@font-face` rule the document's faces need, as the payload.
///
/// This is what makes the document one document: the host writes the rules into
/// its page once, and every page drawn after that names the same faces. A rule
/// names its face by URI rather than carrying it, so this goes with
/// [`wpdf_fonts`], which is where the bytes behind those URIs come from.
///
/// The alternative - embedding the bytes in each page - is what a standalone SVG
/// needs, and is `EMBED_FONTS` on a render.
#[no_mangle]
pub extern "C" fn wpdf_stylesheet(id: u32) -> i32 {
    call(|state| {
        let core = state.docs.get(&id).ok_or("no such document")?;
        Ok(("{}".to_string(), core.stylesheet().into_bytes()))
    })
}

/// Every face's bytes, and the URI the stylesheet names each of them by.
///
/// The header lists the faces in the order their rules were written, each with
/// its family, its URI, the media type and size of its bytes and where those
/// bytes start in the payload; the payload is the bytes themselves, one face
/// after another.
///
/// This is the other half of [`wpdf_stylesheet`]: a host serves each face at its
/// URI - in a browser, `URL.createObjectURL` over the slice - and puts that URL
/// where the rule names the URI. The font crosses the boundary as bytes, and the
/// rule the browser has to parse is a filename rather than the font itself,
/// 4/3 of it again, in base64.
#[no_mangle]
pub extern "C" fn wpdf_fonts(id: u32) -> i32 {
    call(|state| {
        let core = state.docs.get(&id).ok_or("no such document")?;
        let mut payload: Vec<u8> = Vec::new();
        let mut faces: Vec<String> = Vec::new();
        for face in core.faces() {
            let offset = payload.len();
            payload.extend_from_slice(&face.payload);
            faces.push(format!(
                "{{\"family\":{},\"uri\":{},\"format\":\"{}\",\"mime\":\"{}\",\
                 \"bytes\":{},\"offset\":{offset},\"glyphs\":{}}}",
                crate::json::quote(&face.family),
                crate::json::quote(&face.uri),
                face.format,
                face.mime,
                face.bytes,
                face.glyph_count,
            ));
        }
        Ok((format!("{{\"faces\":[{}]}}", faces.join(",")), payload))
    })
}

/// Render one page.
///
/// The header carries the page's display size, its crop box (or null), its links
/// and its statistics; the payload is the SVG.
///
/// # Safety
///
/// `prefix` and `class` must each point at as many readable bytes as they are
/// given as lengths, for the length of the call.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn wpdf_render(
    id: u32,
    page: i32,
    prefix: *const u8,
    prefix_len: usize,
    class: *const u8,
    class_len: usize,
    flags: u32,
    bionic_dim: f32,
    crop_x: f32,
    crop_y: f32,
    crop_w: f32,
    crop_h: f32,
) -> i32 {
    let id_prefix = match unsafe { text(prefix, prefix_len) } {
        Ok(prefix) => prefix,
        Err(error) => return fail(error),
    };
    let class_name = match unsafe { text(class, class_len) } {
        Ok(class) => class,
        Err(error) => return fail(error),
    };
    call(|state| {
        let core = state.docs.get(&id).ok_or("no such document")?;
        let view_box = if flags & flag::CROP != 0 {
            Some((crop_x, crop_y, crop_w, crop_h))
        } else {
            None
        };
        let opts = RenderOptions {
            id_prefix,
            responsive: flags & flag::RESPONSIVE != 0,
            class_name: (!class_name.is_empty()).then_some(class_name),
            embed_fonts: flags & flag::EMBED_FONTS != 0,
            bionic: flags & flag::BIONIC != 0,
            // A negative dimension is the host saying "the default", which is how
            // a `f32` carries an absent option through a C ABI without a second
            // argument.
            bionic_dim: (bionic_dim >= 0.0).then_some(bionic_dim),
            links: flags & flag::LINKS != 0,
            view_box,
        };
        let rendered = core.render_page(page, &opts).map_err(|error| error.to_string())?;
        let crop = match view_box {
            Some((x, y, w, h)) => crop::Box2::new(x, y, w, h).json(),
            None => "null".into(),
        };
        let links: Vec<String> = rendered.links.iter().map(|link| link.json()).collect();
        let stats = rendered.stats;
        let header = format!(
            "{{\"width\":{},\"height\":{},\"crop\":{crop},\"links\":[{}],\"stats\":{{\
             \"glyphs\":{},\"asText\":{},\"asOutlines\":{},\"runs\":{},\"spaces\":{},\
             \"faded\":{},\"fonts\":{},\"images\":{},\"shades\":{}}}}}",
            crate::json::number(rendered.width),
            crate::json::number(rendered.height),
            links.join(","),
            stats.glyphs,
            stats.as_text,
            stats.as_outlines,
            stats.runs,
            stats.spaces,
            stats.faded,
            stats.fonts,
            stats.images,
            stats.shades
        );
        Ok((header, rendered.svg.into_bytes()))
    })
}

/// The box a page's content occupies under a list of patterns, or null for none.
///
/// The patterns arrive as the host joined them - see [`crop::SEPARATOR`] - and
/// are compiled here: an expression that is not one is an ordinary failure, with
/// the reason in the frame, and it is the host that decides what to say about it.
///
/// # Safety
///
/// `patterns` must point at `patterns_len` readable bytes for the length of the
/// call.
#[no_mangle]
pub unsafe extern "C" fn wpdf_measure_crop(
    id: u32,
    page: i32,
    patterns: *const u8,
    patterns_len: usize,
) -> i32 {
    let list = match unsafe { text(patterns, patterns_len) } {
        Ok(list) => list,
        Err(error) => return fail(error),
    };
    let compiled = match crop::compile(&crop::parse_patterns(&list)) {
        Ok(compiled) => compiled,
        Err(error) => return fail(error),
    };
    call(|state| {
        let core = state.docs.get(&id).ok_or("no such document")?;
        let box_ = core
            .measure_crop(page, &compiled)
            .map_err(|error| error.to_string())?;
        let crop = match box_ {
            Some(box_) => box_.json(),
            None => "null".into(),
        };
        Ok((format!("{{\"crop\":{crop}}}"), Vec::new()))
    })
}

/// Whether one regular expression compiles, as the menu's answer to a reader.
///
/// This is an ordinary frame either way - a pattern that does not compile is not
/// a failed call - so that the host reads `ok` and `error` instead of catching
/// something. It exists because a reader types an expression and should be told
/// about a stray bracket before anything is measured, not after.
///
/// # Safety
///
/// `pattern` must point at `pattern_len` readable bytes for the length of the
/// call.
#[no_mangle]
pub unsafe extern "C" fn wpdf_crop_check(pattern: *const u8, pattern_len: usize) -> i32 {
    let pattern = match unsafe { text(pattern, pattern_len) } {
        Ok(pattern) => pattern,
        Err(error) => return fail(error),
    };
    match crop::compile(std::slice::from_ref(&pattern)) {
        // `reason` and not `error`: a frame with an `error` in it is a *failed
        // call* to the host, and a pattern that is not one is an ordinary answer.
        Ok(_) => reply("{\"ok\":true,\"reason\":\"\"}", &[]),
        Err(error) => reply(
            &format!("{{\"ok\":false,\"reason\":{}}}", crate::json::quote(&error)),
            &[],
        ),
    }
}

/// Every link annotation on a page, for a host that wants the data.
#[no_mangle]
pub extern "C" fn wpdf_links(id: u32, page: i32) -> i32 {
    call(|state| {
        let core = state.docs.get(&id).ok_or("no such document")?;
        let links = core.links(page).map_err(|error| error.to_string())?;
        Ok((format!("{{\"links\":{}}}", links_json(&links)), Vec::new()))
    })
}

/// Write the document out again, unencrypted, as the payload.
#[no_mangle]
pub extern "C" fn wpdf_save(id: u32) -> i32 {
    call(|state| {
        let core = state.docs.get(&id).ok_or("no such document")?;
        let bytes = core.save().map_err(|error| error.to_string())?;
        Ok(("{}".to_string(), bytes))
    })
}

/// Where the last answer's bytes are.
#[no_mangle]
pub extern "C" fn wpdf_out_ptr() -> *const u8 {
    STATE.with(|state| state.borrow().out.as_ptr())
}

/// Every export, named, so the linker keeps the code behind it.
///
/// An rlib's `#[no_mangle]` functions are not roots: the linker pulls an object
/// out of an archive only to resolve an undefined symbol, and nothing in a
/// browser host is a Rust symbol. The wasm entry point (`bin/engine.rs`) calls
/// this for exactly that reason, and Emscripten's `EXPORTED_FUNCTIONS` is what
/// then makes them visible to JavaScript.
pub fn keep_exports() {
    let exports: [*const (); 12] = [
        wpdf_open as *const (),
        wpdf_password as *const (),
        wpdf_close as *const (),
        wpdf_info as *const (),
        wpdf_plan as *const (),
        wpdf_stylesheet as *const (),
        wpdf_render as *const (),
        wpdf_measure_crop as *const (),
        wpdf_links as *const (),
        wpdf_save as *const (),
        wpdf_crop_check as *const (),
        wpdf_out_ptr as *const (),
    ];
    std::hint::black_box(exports);
}

#[cfg(test)]
mod test {
    use super::*;

    /// The frame a host parses, without a browser: a header length, the header,
    /// then the payload.
    fn read_frame(out: &[u8]) -> (String, Vec<u8>) {
        let len = u32::from_le_bytes([out[0], out[1], out[2], out[3]]) as usize;
        let header = String::from_utf8(out[4..4 + len].to_vec()).unwrap();
        (header, out[4 + len..].to_vec())
    }

    fn last() -> (String, Vec<u8>) {
        STATE.with(|state| read_frame(&state.borrow().out))
    }

    #[test]
    fn a_string_argument_is_read_and_a_bad_one_is_refused() {
        let bytes = b"hello";
        // SAFETY: the slice is alive for the call.
        let read = unsafe { text(bytes.as_ptr(), bytes.len()) }.unwrap();
        assert_eq!(read, "hello");
        assert_eq!(unsafe { text(std::ptr::null(), 0) }.unwrap(), "");
        assert!(unsafe { text(std::ptr::null(), 4) }.is_err());
        // A lone continuation byte is not UTF-8.
        assert!(unsafe { text(b"\x80".as_ptr(), 1) }.is_err());
    }

    #[test]
    fn a_failure_is_a_frame_with_an_error_and_nothing_else() {
        let len = fail("no such document");
        assert!(len > 0);
        let (header, payload) = last();
        assert_eq!(header, "{\"error\":\"no such document\"}");
        assert!(payload.is_empty());
    }

    #[test]
    fn a_call_that_does_not_know_the_document_says_so() {
        let (header, _) = {
            wpdf_info(9999);
            last()
        };
        assert!(header.contains("\"error\":\"no such document\""));
    }

    #[test]
    fn a_pattern_is_checked_without_a_document() {
        let good = b"^arXiv:";
        // SAFETY: the slice is alive for the call.
        unsafe { wpdf_crop_check(good.as_ptr(), good.len()) };
        let (header, payload) = last();
        assert_eq!(header, "{\"ok\":true,\"reason\":\"\"}");
        assert!(payload.is_empty());

        let bad = b"^(";
        // SAFETY: as above.
        unsafe { wpdf_crop_check(bad.as_ptr(), bad.len()) };
        let (header, _) = last();
        assert!(header.starts_with("{\"ok\":false"), "{header}");
        // `reason`, not `error`: the host reads an `error` field as a failed call.
        assert!(header.contains("\"reason\":\""), "{header}");
        assert!(!header.contains("\"error\""), "{header}");
    }
}
