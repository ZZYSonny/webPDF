//! WOFF (level 1) wrapping.
//!
//! The compiled subset fonts are small, and shipping a second multi-megabyte
//! wasm blob just to gain the last few hundred bytes of WOFF2 brotli was not
//! worth the integration risk. WOFF is understood by every browser, works inside
//! an `<img src="...svg">` document, and needs nothing beyond deflate - which
//! `miniz_oxide` gives without a C dependency, so the same crate still compiles
//! to wasm.
//!
//! Layout follows <https://www.w3.org/TR/WOFF/>: a 44 byte header, one 20 byte
//! directory entry per sfnt table, then the tables, each deflated where that
//! makes it smaller and padded to a four byte boundary.
//!
//! The tables are deflated into the output itself, by one compressor that is
//! reused for all of them. `compress_to_vec_zlib` builds a `CompressorOxide` -
//! a heap huffman table and a 32 KB dictionary - and an output `Vec` per call,
//! and a 756-page document has eight hundred-odd tables: measured on the corpus
//! that was most of what WOFF cost, and one reused compressor writing the same
//! stream took a third of the time.

use std::cell::RefCell;

use miniz_oxide::deflate::core::{
    compress, create_comp_flags_from_zip_params, CompressorOxide, TDEFLFlush, TDEFLStatus,
};

/// How much room beyond its raw bytes a deflated table is given to start with.
///
/// zlib's own bound plus slack: a table that does not shrink is stored as it
/// was, so the buffer only has to be big enough to find that out.
const SLACK: usize = 64;

/// A table's bytes in the output, padded to a four byte boundary.
fn pad(n: usize) -> usize {
    (n + 3) & !3
}

/// One deflate compressor, reused for every table of every face.
struct Deflater {
    compressor: CompressorOxide,
}

impl Deflater {
    fn new() -> Self {
        Self {
            compressor: CompressorOxide::new(create_comp_flags_from_zip_params(9, 1, 0)),
        }
    }

    /// Deflate `input` into `out` starting at `at`, growing `out` as needed, and
    /// say how many bytes were written.
    ///
    /// The compressor holds no state across streams - `reset` is what the
    /// crate's own one-shot helper reaches for between calls - so this writes
    /// the same stream `compress_to_vec_zlib` would, into a buffer that already
    /// exists.
    fn compress_into(&mut self, input: &[u8], out: &mut Vec<u8>, at: usize) -> usize {
        self.compressor.reset();
        let mut input = input;
        let mut pos = at;
        loop {
            if out.len() < pos + SLACK {
                out.resize(pos + SLACK, 0);
            }
            let (status, bytes_in, bytes_out) =
                compress(&mut self.compressor, input, &mut out[pos..], TDEFLFlush::Finish);
            pos += bytes_out;
            match status {
                TDEFLStatus::Done => break,
                TDEFLStatus::Okay if bytes_in <= input.len() => input = &input[bytes_in..],
                // Not supposed to happen unless there is a bug.
                _ => panic!("the table could not be deflated"),
            }
        }
        pos - at
    }
}

thread_local! {
    static DEFLATER: RefCell<Deflater> = RefCell::new(Deflater::new());
}

/// Re-wrap an OpenType font as WOFF, or `None` when it would not be smaller.
pub fn encode(sfnt: &[u8]) -> Option<Vec<u8>> {
    if sfnt.len() < 12 {
        return None;
    }
    let flavor = u32::from_be_bytes([sfnt[0], sfnt[1], sfnt[2], sfnt[3]]);
    let count = u16::from_be_bytes([sfnt[4], sfnt[5]]) as usize;
    if count == 0 || 12 + count * 16 > sfnt.len() {
        return None;
    }

    /// One table's place in the output: where its bytes went, and how long they
    /// were before they were deflated.
    struct Entry {
        tag: [u8; 4],
        at: u32,
        compressed: u32,
        length: u32,
        checksum: u32,
    }

    // The output is the buffer the tables are deflated into: the header is
    // reserved, each table is written after the one before it, and the
    // directory is filled in at the end, when every length is known.
    let header = 44 + count * 20;
    let mut out = vec![0u8; header];
    let mut entries: Vec<Entry> = Vec::with_capacity(count);
    let mut saved = 0usize;

    for i in 0..count {
        let at = 12 + i * 16;
        let mut tag = [0u8; 4];
        tag.copy_from_slice(&sfnt[at..at + 4]);
        let checksum = u32::from_be_bytes([sfnt[at + 4], sfnt[at + 5], sfnt[at + 6], sfnt[at + 7]]);
        let offset = u32::from_be_bytes([sfnt[at + 8], sfnt[at + 9], sfnt[at + 10], sfnt[at + 11]]);
        let length =
            u32::from_be_bytes([sfnt[at + 12], sfnt[at + 13], sfnt[at + 14], sfnt[at + 15]]);
        let (start, end) = (offset as usize, offset as usize + length as usize);
        let raw = sfnt.get(start..end)?;

        let table_at = out.len();
        out.resize(table_at + raw.len() + SLACK, 0);
        let written =
            DEFLATER.with(|cell| cell.borrow_mut().compress_into(raw, &mut out, table_at));
        let payload = if written < raw.len() {
            saved += raw.len() - written;
            written
        } else {
            // Deflate could not make this table smaller, so it goes in as it
            // was: the container's point is fewer bytes.
            out[table_at..table_at + raw.len()].copy_from_slice(raw);
            raw.len()
        };
        out.truncate(table_at + payload);
        out.resize(pad(table_at + payload), 0);

        entries.push(Entry {
            tag,
            at: table_at as u32,
            compressed: payload as u32,
            length,
            checksum,
        });
    }
    if saved == 0 {
        return None;
    }

    let total = out.len();
    let sfnt_size = 12 + entries.len() * 16 + entries.iter().map(|e| pad(e.length as usize)).sum::<usize>();

    out[0..4].copy_from_slice(&0x774f_4646u32.to_be_bytes()); // 'wOFF'
    out[4..8].copy_from_slice(&flavor.to_be_bytes());
    out[8..12].copy_from_slice(&(total as u32).to_be_bytes());
    out[12..14].copy_from_slice(&(entries.len() as u16).to_be_bytes());
    out[16..20].copy_from_slice(&(sfnt_size as u32).to_be_bytes());
    out[20..22].copy_from_slice(&1u16.to_be_bytes()); // majorVersion
    out[22..24].copy_from_slice(&0u16.to_be_bytes()); // minorVersion

    for (i, entry) in entries.iter().enumerate() {
        let p = 44 + i * 20;
        out[p..p + 4].copy_from_slice(&entry.tag);
        out[p + 4..p + 8].copy_from_slice(&entry.at.to_be_bytes());
        out[p + 8..p + 12].copy_from_slice(&entry.compressed.to_be_bytes());
        out[p + 12..p + 16].copy_from_slice(&entry.length.to_be_bytes());
        out[p + 16..p + 20].copy_from_slice(&entry.checksum.to_be_bytes());
    }
    Some(out)
}

#[cfg(test)]
mod test {
    use super::*;

    /// An sfnt with the given tables, laid out the way `build_font` lays one out.
    fn sfnt(tables: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let count = tables.len();
        let mut out = vec![0u8; 12 + count * 16];
        out[0..4].copy_from_slice(&0x0001_0000u32.to_be_bytes()); // TrueType flavor
        out[4..6].copy_from_slice(&(count as u16).to_be_bytes());
        let mut at = 12 + count * 16;
        for (i, (tag, data)) in tables.iter().enumerate() {
            let p = 12 + i * 16;
            out[p..p + 4].copy_from_slice(*tag);
            out[p + 8..p + 12].copy_from_slice(&(at as u32).to_be_bytes());
            out[p + 12..p + 16].copy_from_slice(&(data.len() as u32).to_be_bytes());
            out.resize(at + data.len(), 0);
            out[at..at + data.len()].copy_from_slice(data);
            at += pad(data.len());
        }
        out
    }

    /// The reuse has to be invisible: same bytes as the one-shot helper, every
    /// time, whether the output buffer is large enough or has to grow.
    #[test]
    fn a_reused_compressor_writes_the_one_shot_stream() {
        let data: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
        let once = miniz_oxide::deflate::compress_to_vec_zlib(&data, 9);
        let mut deflater = Deflater::new();
        for room in [data.len() + SLACK, 32] {
            let mut out = vec![0u8; room];
            for _ in 0..3 {
                let written = deflater.compress_into(&data, &mut out, 0);
                assert_eq!(&out[..written], once.as_slice());
            }
        }
    }

    /// Every table is where the directory says it is, is on a four byte
    /// boundary, and holds what it held before - deflated or not.
    #[test]
    fn tables_are_laid_out_and_read_back() {
        let soft: Vec<u8> = (0..1024).map(|i| (i % 7) as u8).collect();
        let hard: Vec<u8> = (0..512u32)
            .map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8)
            .collect();
        let font = sfnt(&[(b"glyf", soft.clone()), (b"head", hard.clone())]);
        let woff = encode(&font).expect("one table deflates");

        assert_eq!(&woff[0..4], b"wOFF");
        assert_eq!(u32::from_be_bytes([woff[4], woff[5], woff[6], woff[7]]), 0x0001_0000);
        assert_eq!(
            u32::from_be_bytes([woff[8], woff[9], woff[10], woff[11]]) as usize,
            woff.len()
        );
        assert_eq!(u16::from_be_bytes([woff[12], woff[13]]), 2);
        assert_eq!(
            u32::from_be_bytes([woff[16], woff[17], woff[18], woff[19]]) as usize,
            12 + 2 * 16 + pad(soft.len()) + pad(hard.len())
        );

        let mut compressed = 0;
        for (i, raw) in [&soft, &hard].into_iter().enumerate() {
            let p = 44 + i * 20;
            let mut tag = [0u8; 4];
            tag.copy_from_slice(&woff[p..p + 4]);
            let at = u32::from_be_bytes([woff[p + 4], woff[p + 5], woff[p + 6], woff[p + 7]]) as usize;
            let comp =
                u32::from_be_bytes([woff[p + 8], woff[p + 9], woff[p + 10], woff[p + 11]]) as usize;
            let orig = u32::from_be_bytes([
                woff[p + 12],
                woff[p + 13],
                woff[p + 14],
                woff[p + 15],
            ]) as usize;
            assert_eq!(orig, raw.len());
            assert_eq!(at % 4, 0);
            assert_eq!(tag, if i == 0 { *b"glyf" } else { *b"head" });

            let body = &woff[at..at + comp];
            if comp < orig {
                compressed += 1;
                assert_eq!(
                    miniz_oxide::inflate::decompress_to_vec_zlib(body).expect("inflates"),
                    *raw
                );
            } else {
                assert_eq!(body, raw.as_slice());
            }
            for byte in &woff[at + comp..pad(at + comp)] {
                assert_eq!(*byte, 0, "padding is zero");
            }
        }
        assert_eq!(compressed, 1, "the compressible table is deflated");
    }
}
