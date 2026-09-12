//! Link annotations: what a PDF's links point at, and the SVG hit areas that make
//! them clickable.
//!
//! A PDF link is an invisible rectangle over the page content, so a viewer has to
//! supply both the target and the affordance. MuPDF gives the target
//! (`Page::links`); this module turns it into
//!
//!  - [`PageLink`] values, which are plain data and cross the wasm boundary as
//!    JSON unchanged, and
//!  - one `<a>` per link, holding a transparent `<rect>`, written into the page's
//!    SVG by [`inject`].
//!
//! The hit areas live *inside the SVG* rather than in an overlay element, so they
//! scale with the page at any zoom without anyone re-measuring anything, and a
//! downloaded SVG carries its links.
//!
//! A PDF is untrusted input, so an `href` - which is an instruction to the
//! browser to navigate - is written only for the schemes in [`is_openable_uri`].
//! Everything else is still reported, still gets a hit area, and is left for the
//! host to deal with.
//!
//! Geometry is in MuPDF's page space: points, origin at the page's top-left. That
//! is also the SVG's user space, because the page's bounds are normalised to the
//! origin and the SVG writer puts them in the `viewBox` verbatim - so no rect is
//! ever transformed here.

use mupdf::{DestinationKind, Document, Page};

/// A rectangle in page coordinates: `[x0, y0, x1, y1]`, points, top-left origin.
pub type LinkRect = [f32; 4];

/// One link annotation on a page.
#[derive(Clone, Debug)]
pub enum PageLink {
    Internal {
        rect: LinkRect,
        /// 1-based destination page, or -1 when the destination cannot be
        /// resolved.
        page: i32,
        /// Destination point in points from the target page's top-left, when the
        /// PDF gives one.
        x: Option<f32>,
        y: Option<f32>,
    },
    External {
        rect: LinkRect,
        /// The URI exactly as the PDF stores it. Not necessarily safe to
        /// navigate to.
        uri: String,
    },
}

impl PageLink {
    pub fn rect(&self) -> LinkRect {
        match self {
            PageLink::Internal { rect, .. } | PageLink::External { rect, .. } => *rect,
        }
    }

    /// As JSON, which is how a host reads a page's links.
    pub fn json(&self) -> String {
        let rect = self.rect();
        let rect = format!(
            "[{},{},{},{}]",
            crate::json::number(rect[0]),
            crate::json::number(rect[1]),
            crate::json::number(rect[2]),
            crate::json::number(rect[3])
        );
        match self {
            PageLink::Internal { page, x, y, .. } => format!(
                "{{\"kind\":\"internal\",\"rect\":{rect},\"page\":{page},\"x\":{},\"y\":{}}}",
                crate::json::opt_number(*x),
                crate::json::opt_number(*y)
            ),
            PageLink::External { uri, .. } => format!(
                "{{\"kind\":\"external\",\"rect\":{rect},\"uri\":{}}}",
                crate::json::quote(uri)
            ),
        }
    }
}

/// A page's links as a JSON array.
pub fn links_json(links: &[PageLink]) -> String {
    let parts: Vec<String> = links.iter().map(PageLink::json).collect();
    format!("[{}]", parts.join(","))
}

/// Whether a URI names an address outside the document.
///
/// This is `fz_is_external_link` itself, spelled out: a valid scheme - a letter,
/// then letters, digits, `+`, `-` or `.`, then a colon, at least two characters
/// long - means "out of the document", and anything else (`#page=4`, a named
/// destination, an empty string) is a place inside it. That distinction is what
/// makes `http://example.com` an `href` and `#page=4` a jump, and it is the
/// document's own answer rather than a guess made from the URI's spelling.
fn is_external_link(uri: &str) -> bool {
    let bytes = uri.as_bytes();
    let Some(&first) = bytes.first() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    let mut at = 1;
    while at < bytes.len()
        && (bytes[at].is_ascii_alphanumeric()
            || bytes[at] == b'+'
            || bytes[at] == b'-'
            || bytes[at] == b'.')
    {
        at += 1;
    }
    at < bytes.len() && bytes[at] == b':' && at > 1
}

/// Every link annotation on a page, as plain data.
///
/// Nothing here is allowed to fail the page: a broken annotation is skipped, an
/// unresolvable destination is reported with page -1 (the host then leaves it
/// alone rather than inventing a target), and an unknown URI is reported as it is
/// - deciding what is safe to open is [`is_openable_uri`]'s job, at the point
/// where an `href` would be written.
pub fn page_links(_doc: &Document, page: &Page) -> Vec<PageLink> {
    let mut out = Vec::new();
    let links = match page.links() {
        Ok(links) => links,
        // A page whose annotation list cannot be read has no links, not a failed
        // render.
        Err(_) => return out,
    };
    for link in links {
        let bounds = link.bounds;
        let rect: LinkRect = [bounds.x0, bounds.y0, bounds.x1, bounds.y1];
        if !rect.iter().all(|v| v.is_finite()) {
            continue;
        }
        match link.dest {
            // The destination resolved: a place in this document.
            Some(dest) => {
                let (x, y) = destination_point(&dest.kind);
                out.push(PageLink::Internal {
                    rect,
                    // `page_number` is absolute to the start of the document and
                    // 0-based; the host counts pages from one, as a reader does.
                    page: dest.loc.page_number as i32 + 1,
                    x,
                    y,
                });
            }
            // No destination. Either the link leaves the document, or it names a
            // place in it that is not there - and the URI is what tells those
            // apart.
            None if is_external_link(&link.uri) => out.push(PageLink::External {
                rect,
                uri: link.uri,
            }),
            None => out.push(PageLink::Internal {
                rect,
                page: -1,
                x: None,
                y: None,
            }),
        }
    }
    out
}

/// Where on the target page the destination points, when the PDF says.
///
/// The zoom and fit variants carry the interesting numbers in different fields -
/// a `/FitH` has a top, a `/FitV` a left, an `/XYZ` either or both - so all of
/// them are folded into one optional point, which is all a viewer scrolls to.
fn destination_point(kind: &DestinationKind) -> (Option<f32>, Option<f32>) {
    let finite = |value: Option<f32>| value.filter(|v| v.is_finite());
    match *kind {
        DestinationKind::FitH { top } | DestinationKind::FitBH { top } => (None, finite(top)),
        DestinationKind::FitV { left } | DestinationKind::FitBV { left } => (finite(left), None),
        DestinationKind::XYZ { left, top, .. } => (finite(left), finite(top)),
        DestinationKind::FitR {
            left,
            bottom: _,
            right: _,
            top,
        } => (finite(Some(left)), finite(Some(top))),
        _ => (None, None),
    }
}

/// Schemes a browser will actually follow.
///
/// `javascript:`, `data:`, `vbscript:` and `file:` are not on the list, and
/// neither is a relative path - a PDF has no base URL, so there is nothing to
/// resolve one against.
pub fn is_openable_uri(uri: &str) -> bool {
    let lower = uri.to_ascii_lowercase();
    for scheme in ["http://", "https://", "mailto:", "tel:"] {
        if let Some(rest) = lower.strip_prefix(scheme) {
            // `\S` after the colon: a scheme with nothing after it navigates
            // nowhere, and `mailto:` with no address is not a link.
            if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
                return true;
            }
        }
    }
    false
}

const XML_ESCAPE: [(char, &str); 5] = [
    ('&', "&amp;"),
    ('<', "&lt;"),
    ('>', "&gt;"),
    ('"', "&quot;"),
    ('\'', "&apos;"),
];

/// Make a string safe to put inside a double-quoted XML attribute.
///
/// Escaping the five entities is not enough: XML 1.0 has no representation at all
/// - not even as a numeric reference - for C0 control characters and lone
/// surrogates, and one of those in a link URI would make the whole SVG
/// unparseable. They are dropped instead.
fn xml_attr(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        let cp = c as u32;
        if cp < 0x20 {
            if cp != 0x09 && cp != 0x0a && cp != 0x0d {
                continue;
            }
        } else if cp == 0x7f || cp == 0xfffe || cp == 0xffff {
            continue;
        }
        match XML_ESCAPE.iter().find(|(from, _)| *from == c) {
            Some((_, to)) => out.push_str(to),
            None => out.push(c),
        }
    }
    out
}

/// Two decimals is well under a device pixel even at 400%, and half the bytes.
fn num(value: f32) -> String {
    if !value.is_finite() {
        return "0".into();
    }
    crate::json::number((value * 100.0).round() / 100.0)
}

/// The `<a>` + transparent `<rect>` markup for a page's links, or `""` when none
/// of them can be clicked.
///
/// A link with a degenerate rectangle has nothing to click and a link whose
/// destination could not be resolved has nowhere to go; both were reported as
/// data and both are skipped here.
///
/// The rectangles are transparent rather than `fill="none"`: an unpainted shape
/// is not a hit-test target at all, and the whole point is to be clicked.
pub fn svg_links(links: &[PageLink]) -> String {
    let mut parts = String::new();
    for link in links {
        let [x0, y0, x1, y1] = link.rect();
        if !(x1 > x0) || !(y1 > y0) {
            continue;
        }
        let mut attrs = String::from("class=\"wpdf-link\"");
        match link {
            PageLink::Internal { page, y, .. } => {
                if *page < 1 {
                    continue;
                }
                attrs.push_str(&format!(
                    " data-wpdf-link=\"internal\" data-wpdf-page=\"{page}\" title=\"Page {page}\""
                ));
                if let Some(y) = y.filter(|v| v.is_finite()) {
                    attrs.push_str(&format!(" data-wpdf-y=\"{}\"", num(y)));
                }
            }
            PageLink::External { uri, .. } => {
                let uri = xml_attr(uri);
                attrs.push_str(&format!(
                    " data-wpdf-link=\"external\" data-wpdf-uri=\"{uri}\" title=\"{uri}\""
                ));
                if is_openable_uri(uri.as_str()) {
                    attrs.push_str(&format!(
                        " href=\"{uri}\" target=\"_blank\" rel=\"noopener noreferrer\""
                    ));
                }
            }
        }
        // Focusable so the hit areas are reachable without a mouse; the host
        // wires Enter and Space to the same jump a click makes.
        attrs.push_str(" tabindex=\"0\"");

        parts.push_str(&format!(
            "<a {attrs}><rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\"/></a>",
            num(x0),
            num(y0),
            num(x1 - x0),
            num(y1 - y0)
        ));
    }
    if parts.is_empty() {
        return String::new();
    }
    format!("<g class=\"wpdf-links\" fill=\"transparent\">{parts}</g>")
}

/// Append link hit areas to a rendered page, just before its closing tag.
pub fn inject(svg: &str, links: &[PageLink]) -> String {
    let markup = svg_links(links);
    if markup.is_empty() {
        return svg.to_string();
    }
    match svg.rfind("</svg>") {
        Some(at) => format!("{}{markup}{}", &svg[..at], &svg[at..]),
        None => svg.to_string(),
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn a_scheme_is_what_makes_a_link_external() {
        assert!(is_external_link("http://example.com"));
        assert!(is_external_link("mailto:a@b.c"));
        assert!(is_external_link("a+b-c.d:x"));
        // A scheme is at least one more character after the first letter.
        assert!(!is_external_link("a:"));
        assert!(!is_external_link("#page=4"));
        assert!(!is_external_link("example.com"));
        assert!(!is_external_link(""));
        assert!(!is_external_link("1http://x"));
    }

    #[test]
    fn only_a_scheme_a_browser_follows_becomes_an_href() {
        assert!(is_openable_uri("https://example.com/a"));
        assert!(is_openable_uri("MAILTO:a@b.c"));
        assert!(!is_openable_uri("javascript:alert(1)"));
        assert!(!is_openable_uri("data:text/html,x"));
        assert!(!is_openable_uri("file:///etc/passwd"));
        assert!(!is_openable_uri("/relative"));
        assert!(!is_openable_uri("https://"));
    }

    #[test]
    fn a_hit_area_is_written_for_a_link_and_not_for_a_dead_rectangle() {
        let link = PageLink::Internal {
            rect: [10.0, 20.0, 30.0, 40.0],
            page: 3,
            x: None,
            y: Some(12.345),
        };
        let markup = svg_links(&[link]);
        assert!(markup.contains("data-wpdf-link=\"internal\""));
        assert!(markup.contains("data-wpdf-page=\"3\""));
        assert!(markup.contains("data-wpdf-y=\"12.35\""));
        assert!(markup.contains("<rect x=\"10\" y=\"20\" width=\"20\" height=\"20\"/>"));
        assert!(markup.starts_with("<g class=\"wpdf-links\" fill=\"transparent\">"));

        // Nowhere to go, and nothing to click.
        let dead = PageLink::Internal {
            rect: [10.0, 20.0, 30.0, 40.0],
            page: -1,
            x: None,
            y: None,
        };
        assert_eq!(svg_links(&[dead]), "");
        let empty = PageLink::External {
            rect: [0.0, 0.0, 0.0, 0.0],
            uri: "https://example.com".into(),
        };
        assert_eq!(svg_links(&[empty]), "");
    }

    #[test]
    fn an_href_is_written_only_for_a_uri_a_browser_would_follow() {
        let openable = PageLink::External {
            rect: [0.0, 0.0, 5.0, 5.0],
            uri: "https://example.com/a?b=1&c=2".into(),
        };
        let markup = svg_links(&[openable]);
        assert!(markup.contains("href=\"https://example.com/a?b=1&amp;c=2\""));

        let hostile = PageLink::External {
            rect: [0.0, 0.0, 5.0, 5.0],
            uri: "javascript:alert(1)".into(),
        };
        let markup = svg_links(&[hostile]);
        assert!(!markup.contains("href="));
        assert!(markup.contains("data-wpdf-uri=\"javascript:alert(1)\""));
    }

    #[test]
    fn a_control_character_in_a_uri_is_dropped_rather_than_escaped() {
        let link = PageLink::External {
            rect: [0.0, 0.0, 5.0, 5.0],
            uri: "https://example.com/a\u{1}b".into(),
        };
        let markup = svg_links(&[link]);
        assert!(markup.contains("data-wpdf-uri=\"https://example.com/ab\""));
    }

    #[test]
    fn the_hit_areas_go_inside_the_page_and_not_after_it() {
        let svg = "<svg><g/></svg>";
        let link = PageLink::External {
            rect: [0.0, 0.0, 5.0, 5.0],
            uri: "https://example.com".into(),
        };
        let out = inject(svg, &[link]);
        assert!(out.starts_with("<svg><g/>"));
        assert!(out.ends_with("</svg>"));
        assert_eq!(inject(svg, &[]), svg);
    }
}
