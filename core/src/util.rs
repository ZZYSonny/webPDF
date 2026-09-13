//! Small helpers the rest of the core is built out of.
//!
//! The one that matters is [`OrderedMap`]: a good deal of what the font plan
//! decides is "the first one wins" or "the last one wins", and a hash map's
//! iteration order is neither. Keeping the insertion order makes the plan's
//! answers the same on every run *and* the same as the pipeline this replaces,
//! which is what lets the two be compared at all.

use std::collections::HashMap;
use std::hash::Hash;

/// A map that remembers the order its keys arrived in.
#[derive(Clone, Debug, Default)]
pub struct OrderedMap<K, V> {
    entries: Vec<(K, V)>,
    index: HashMap<K, usize>,
}

impl<K: Eq + Hash + Clone, V> OrderedMap<K, V> {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            index: HashMap::new(),
        }
    }

    /// Insert, keeping the position of a key that is already there.
    pub fn set(&mut self, key: K, value: V) {
        match self.index.get(&key) {
            Some(at) => self.entries[*at].1 = value,
            None => {
                self.index.insert(key.clone(), self.entries.len());
                self.entries.push((key, value));
            }
        }
    }

    /// Insert, returning whether the key was new.
    pub fn insert(&mut self, key: K, value: V) -> bool {
        let fresh = !self.index.contains_key(&key);
        self.set(key, value);
        fresh
    }

    pub fn get(&self, key: &K) -> Option<&V> {
        self.index.get(key).map(|at| &self.entries[*at].1)
    }

    /// The value for a key, created empty when it is not there yet.
    pub fn entry_default(&mut self, key: K) -> &mut V
    where
        V: Default,
    {
        if !self.index.contains_key(&key) {
            self.set(key.clone(), V::default());
        }
        let at = self.index[&key];
        &mut self.entries[at].1
    }

    pub fn contains_key(&self, key: &K) -> bool {
        self.index.contains_key(key)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.entries.iter().map(|(k, v)| (k, v))
    }

    pub fn keys(&self) -> impl Iterator<Item = &K> {
        self.entries.iter().map(|(k, _)| k)
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.entries.iter().map(|(_, v)| v)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// The base-36 spelling of a 32-bit number, which is how a family name stays
/// short enough to be worth writing into every `<text>` element.
pub fn base36(mut value: u32) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        out.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// The content hash a family name is minted from, fed a field at a time.
///
/// Two identical fonts have to reach one family however they were spelled, and
/// two different ones must not collide - so the name is a hash of everything the
/// built face holds. It is fed *bytes* rather than a written-out spelling of
/// them: a glyph's outline spelled as text is one `format!` per path command,
/// and a face is built from hundreds of thousands of them.
pub struct Digest {
    a: u32,
    b: u32,
}

impl Digest {
    pub fn new() -> Self {
        Self {
            a: 0x811c_9dc5,
            b: 0x9e37_79b9,
        }
    }

    /// Feed bytes, whatever they mean.
    pub fn bytes(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.a = (self.a ^ *byte as u32).wrapping_mul(0x0100_0193);
            self.b = (self.b ^ *byte as u32).wrapping_mul(0x85eb_ca6b);
        }
    }

    /// Feed one number.
    pub fn u32(&mut self, value: u32) {
        self.bytes(&value.to_le_bytes());
    }

    /// Feed one coordinate by its bit pattern. A rounded spelling would make two
    /// outlines look like one font, and one of the two would then be wrong.
    pub fn f32(&mut self, value: f32) {
        self.bytes(&value.to_bits().to_le_bytes());
    }

    /// End a field, so that two of them cannot be read as one.
    pub fn end_field(&mut self) {
        self.a = (self.a ^ 0x1f).wrapping_mul(0x0100_0193);
    }

    /// The hash as the base-36 pair a family name is made of.
    pub fn name(&self) -> String {
        format!("{}{}", base36(self.a), base36(self.b))
    }
}

impl Default for Digest {
    fn default() -> Self {
        Self::new()
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64, which is the shape a `data:` URL wants.
pub fn base64(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// The characters of a string, counted the way a `<tspan>` counts them: a
/// character outside the BMP is one, however many bytes it took.
pub fn char_count(text: &str) -> usize {
    text.chars().count()
}

#[cfg(test)]
mod test {
    use super::*;

    /// The digest is the fields it was fed, boundaries included.
    #[test]
    fn a_digest_is_what_it_was_fed() {
        let mut one = Digest::new();
        one.u32(7);
        one.f32(0.5);
        one.end_field();

        let mut same = Digest::new();
        same.u32(7);
        same.f32(0.5);
        same.end_field();
        assert_eq!(one.name(), same.name());

        // A field boundary is content: two fields cannot read as one.
        let mut split = Digest::new();
        split.u32(7);
        split.end_field();
        split.f32(0.5);
        split.end_field();
        assert_ne!(one.name(), split.name());

        let mut other = Digest::new();
        other.u32(8);
        other.f32(0.5);
        other.end_field();
        assert_ne!(one.name(), other.name());

        // Nothing is fed, nothing is claimed: an empty digest still names.
        assert!(!Digest::new().name().is_empty());
    }
}
