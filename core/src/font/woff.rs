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

    struct Entry {
        tag: [u8; 4],
        offset: u32,
        length: u32,
        checksum: u32,
        payload: Vec<u8>,
        compressed: bool,
    }

    let mut entries = Vec::with_capacity(count);
    let mut saved = 0usize;
    for i in 0..count {
        let at = 12 + i * 16;
        let mut tag = [0u8; 4];
        tag.copy_from_slice(&sfnt[at..at + 4]);
        let checksum = u32::from_be_bytes([
            sfnt[at + 4],
            sfnt[at + 5],
            sfnt[at + 6],
            sfnt[at + 7],
        ]);
        let offset = u32::from_be_bytes([
            sfnt[at + 8],
            sfnt[at + 9],
            sfnt[at + 10],
            sfnt[at + 11],
        ]);
        let length = u32::from_be_bytes([
            sfnt[at + 12],
            sfnt[at + 13],
            sfnt[at + 14],
            sfnt[at + 15],
        ]);
        let (start, end) = (offset as usize, offset as usize + length as usize);
        let raw = sfnt.get(start..end)?;
        let deflated = miniz_oxide::deflate::compress_to_vec_zlib(raw, 9);
        if deflated.len() < raw.len() {
            saved += raw.len() - deflated.len();
            entries.push(Entry {
                tag,
                offset,
                length,
                checksum,
                payload: deflated,
                compressed: true,
            });
        } else {
            entries.push(Entry {
                tag,
                offset,
                length,
                checksum,
                payload: raw.to_vec(),
                compressed: false,
            });
        }
    }
    if saved == 0 {
        return None;
    }

    let pad = |n: usize| (n + 3) & !3;
    let header = 44 + entries.len() * 20;
    let mut total = header;
    for entry in &entries {
        total += pad(entry.payload.len());
    }
    let sfnt_size = 12 + entries.len() * 16 + entries.iter().map(|e| pad(e.length as usize)).sum::<usize>();

    let mut out = vec![0u8; total];
    out[0..4].copy_from_slice(&0x774f_4646u32.to_be_bytes()); // 'wOFF'
    out[4..8].copy_from_slice(&flavor.to_be_bytes());
    out[8..12].copy_from_slice(&(total as u32).to_be_bytes());
    out[12..14].copy_from_slice(&(entries.len() as u16).to_be_bytes());
    out[16..20].copy_from_slice(&(sfnt_size as u32).to_be_bytes());
    out[20..22].copy_from_slice(&1u16.to_be_bytes()); // majorVersion
    out[22..24].copy_from_slice(&0u16.to_be_bytes()); // minorVersion

    let mut at = header;
    for (i, entry) in entries.iter().enumerate() {
        let p = 44 + i * 20;
        out[p..p + 4].copy_from_slice(&entry.tag);
        out[p + 4..p + 8].copy_from_slice(&(at as u32).to_be_bytes());
        out[p + 8..p + 12].copy_from_slice(&(entry.payload.len() as u32).to_be_bytes());
        out[p + 12..p + 16].copy_from_slice(&entry.length.to_be_bytes());
        out[p + 16..p + 20].copy_from_slice(&entry.checksum.to_be_bytes());
        // The original offset is kept in `Entry` only so the sfnt can be
        // rebuilt; WOFF itself does not carry it.
        let _ = entry.offset;
        let _ = entry.compressed;
        out[at..at + entry.payload.len()].copy_from_slice(&entry.payload);
        at += pad(entry.payload.len());
    }
    Some(out)
}
