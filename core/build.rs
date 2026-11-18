//! Generate the word list bionic reading's **Common words only** scope uses.
//!
//! The words come from the `common-words-all` crate - its English 1-gram list,
//! the 10,000 most frequent words in Google Books, MIT-licensed - rather than
//! from a file in this repository. It is a *build* dependency, so the data is
//! fetched by cargo like any other dependency, and the page's wasm carries only
//! the sorted words it searches rather than the crate's ten thousand records
//! with their frequencies.
//!
//! The generated file is `$OUT_DIR/common-words.txt`; `src/bionic.rs` includes
//! it with `include_str!`.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    // The core only looks a word up when every character is a letter, so entries
    // with a space, an apostrophe or a digit are dropped here. Folding to lower
    // case is what makes a page's `The` and `the` the same word.
    let mut words: Vec<String> = common_words_all::generated::cwa_1grams_english
        .iter()
        .map(|record| record.ngram)
        .filter(|word| !word.is_empty() && word.chars().all(|c| c.is_ascii_alphabetic()))
        .map(|word| word.to_ascii_lowercase())
        .collect();

    // The lookup is a binary search, so the file has to be sorted, unique and
    // one word per line. Folding case can merge two entries (`The` and `the`),
    // which is why the sort comes after it.
    words.sort_unstable();
    words.dedup();

    let mut out = String::with_capacity(words.iter().map(|word| word.len() + 1).sum());
    for word in &words {
        out.push_str(word);
        out.push('\n');
    }

    let path = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"))
        .join("common-words.txt");
    fs::write(&path, out).expect("write the common word list");
}
