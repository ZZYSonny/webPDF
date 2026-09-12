//! What a document says about itself.
//!
//! Everything a reader sees before the first page is drawn: the title and author
//! a window shows, the box of every page (so a viewer can lay out a scroll before
//! rendering one), the label a page carries when the document numbers its pages
//! its own way, the bookmarks in its outline, and whether it is locked.
//!
//! This is one walk of the document's dictionaries and one page load per page,
//! and it happens once, when the document opens. Nothing here draws anything.

use mupdf::pdf::PdfDocument;
use mupdf::{Document, Error, MetadataName, Outline};

/// The box of one page, in points.
#[derive(Clone, Copy, Debug)]
pub struct PageGeometry {
    pub width: f32,
    pub height: f32,
}

/// One bookmark, and everything under it.
#[derive(Clone, Debug)]
pub struct OutlineNode {
    pub title: String,
    /// 1-based page, or -1 when the destination is not a page (a URI, or a
    /// destination this document cannot resolve).
    pub page: i32,
    pub uri: Option<String>,
    pub children: Vec<OutlineNode>,
}

/// A document as its own metadata describes it.
#[derive(Clone, Debug)]
pub struct DocInfo {
    pub page_count: i32,
    pub title: String,
    pub author: String,
    pub subject: String,
    pub producer: String,
    pub outline: Vec<OutlineNode>,
    pub pages: Vec<PageGeometry>,
    pub labels: Vec<String>,
    /// True when the document is encrypted and has not been unlocked.
    pub encrypted: bool,
}

/// Read everything a document says about itself.
///
/// A page's label is allowed to fail - a document with a broken number tree still
/// has pages, and a viewport that cannot label them can still show them - so a
/// label falls back to the page's own number. A page whose bounds cannot be read
/// is the one thing that cannot be papered over, because the layout is built from
/// them.
pub fn read(doc: &Document) -> Result<DocInfo, Error> {
    let page_count = doc.page_count()?;
    let pdf = PdfDocument::try_from(doc.clone()).ok();

    let mut pages = Vec::with_capacity(page_count as usize);
    let mut labels = Vec::with_capacity(page_count as usize);
    for index in 0..page_count {
        let page = doc.load_page(index)?;
        let bounds = page.bounds()?;
        pages.push(PageGeometry {
            width: bounds.x1 - bounds.x0,
            height: bounds.y1 - bounds.y0,
        });
        labels.push(
            pdf.as_ref()
                .and_then(|pdf| pdf.page_label(index as usize).ok())
                .filter(|label| !label.is_empty())
                .unwrap_or_else(|| (index + 1).to_string()),
        );
    }

    Ok(DocInfo {
        page_count,
        title: metadata(doc, MetadataName::Title),
        author: metadata(doc, MetadataName::Author),
        subject: metadata(doc, MetadataName::Subject),
        producer: metadata(doc, MetadataName::Producer),
        outline: doc.outlines().unwrap_or_default().iter().map(node).collect(),
        pages,
        labels,
        encrypted: doc.needs_password().unwrap_or(false),
    })
}

/// One metadata field, as the document spells it, or empty when it has none.
fn metadata(doc: &Document, name: MetadataName) -> String {
    doc.metadata(name).unwrap_or_default()
}

fn node(outline: &Outline) -> OutlineNode {
    let dest = outline.dest.as_ref();
    let page = match dest {
        Some(dest) if dest.loc.page_number != u32::MAX => dest.loc.page_number as i32 + 1,
        _ => -1,
    };
    OutlineNode {
        title: outline.title.clone(),
        page,
        uri: outline.uri.clone().filter(|uri| !uri.is_empty()),
        children: outline.down.iter().map(node).collect(),
    }
}

/// The whole answer as JSON, which is how the host reads it.
pub fn to_json(info: &DocInfo) -> String {
    let pages: Vec<String> = info
        .pages
        .iter()
        .map(|page| {
            format!(
                "{{\"width\":{},\"height\":{}}}",
                crate::json::number(page.width),
                crate::json::number(page.height)
            )
        })
        .collect();
    let labels: Vec<String> = info.labels.iter().map(|label| crate::json::quote(label)).collect();
    let outline: Vec<String> = info.outline.iter().map(outline_json).collect();
    format!(
        "{{\"pageCount\":{},\"title\":{},\"author\":{},\"subject\":{},\"producer\":{},\
         \"encrypted\":{},\"pages\":[{}],\"labels\":[{}],\"outline\":[{}]}}",
        info.page_count,
        crate::json::quote(&info.title),
        crate::json::quote(&info.author),
        crate::json::quote(&info.subject),
        crate::json::quote(&info.producer),
        info.encrypted,
        pages.join(","),
        labels.join(","),
        outline.join(",")
    )
}

fn outline_json(node: &OutlineNode) -> String {
    let children: Vec<String> = node.children.iter().map(outline_json).collect();
    let uri = match &node.uri {
        Some(uri) => crate::json::quote(uri),
        None => "null".into(),
    };
    format!(
        "{{\"title\":{},\"page\":{},\"uri\":{},\"children\":[{}]}}",
        crate::json::quote(&node.title),
        node.page,
        uri,
        children.join(",")
    )
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn a_destination_that_is_not_a_page_is_reported_as_nowhere() {
        // A URI-only bookmark, and one with no destination at all.
        let orphan = OutlineNode {
            title: "elsewhere".into(),
            page: -1,
            uri: Some("https://example.com".into()),
            children: Vec::new(),
        };
        let json = outline_json(&orphan);
        assert!(json.contains("\"page\":-1"));
        assert!(json.contains("\"uri\":\"https://example.com\""));
        assert!(json.contains("\"children\":[]"));
        assert!(outline_json(&OutlineNode { uri: None, ..orphan }).contains("\"uri\":null"));
    }

    #[test]
    fn the_info_a_host_reads_keeps_its_page_boxes_in_order() {
        let info = DocInfo {
            page_count: 2,
            title: "a\"b".into(),
            author: String::new(),
            subject: String::new(),
            producer: String::new(),
            outline: Vec::new(),
            pages: vec![
                PageGeometry { width: 612.0, height: 792.0 },
                PageGeometry { width: 595.0, height: 842.0 },
            ],
            labels: vec!["i".into(), "ii".into()],
            encrypted: false,
        };
        let json = to_json(&info);
        assert!(json.contains("\"pageCount\":2"));
        assert!(json.contains("\"title\":\"a\\\"b\""));
        assert!(json.contains("{\"width\":612,\"height\":792}"));
        assert!(json.contains("\"labels\":[\"i\",\"ii\"]"));
        assert!(json.contains("\"outline\":[]"));
    }
}
