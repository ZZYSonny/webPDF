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

/// The content hash a family name is minted from.
///
/// Two identical fonts have to reach one family however they were spelled, and
/// two different ones must not collide - so the name is a hash of everything the
/// built face holds.
pub fn content_hash(parts: &[String]) -> String {
    let mut a: u32 = 0x811c9dc5;
    let mut b: u32 = 0x9e3779b9;
    for part in parts {
        for byte in part.bytes() {
            a = (a ^ byte as u32).wrapping_mul(0x0100_0193);
            b = (b ^ byte as u32).wrapping_mul(0x85eb_ca6b);
        }
        a = (a ^ 0x1f).wrapping_mul(0x0100_0193);
    }
    format!("{}{}", base36(a), base36(b))
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
