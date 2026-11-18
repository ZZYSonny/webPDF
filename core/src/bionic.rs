//! Bionic reading: where each word's fixation points are.
//!
//! The method gives every word a *fixation point* - its first letters, so the eye
//! has somewhere to land and the brain finishes the word on its own. How many
//! letters that is comes from a table indexed by word length, which is why the
//! answer is not simply "the first three": `bioneer` holds the table and the rule
//! (`get_fixation`), and this module is only the part that turns its answer into
//! something a page of positioned glyphs can be drawn from.
//!
//! `bioneer` is a Rust port of `text-vide`, the JavaScript library the
//! TypeScript pipeline this core replaces used, and it works the way that one
//! does: it is handed a string, and it returns the string with `<b>` around each
//! fixation point. Markup is of no use to a device that has one positioned glyph
//! per character and needs to know *which* of them to fade, so the tags are read
//! back out here as segments - a segment being a stretch of text and whether it
//! is a fixation point. The same trick, for the same reason, as the pipeline
//! this replaces: markup cannot be dropped into an SVG `<text>`, because inside
//! foreign content an HTML parser treats `<b>` as a breakout tag.
//!
//! What is handed to `bioneer` is *not* the page's text verbatim, because both
//! it and `text-vide` look for markup before they look for words, and markup that
//! is really text would hide a word from them:
//!
//!   * `bioneer` skips anything inside `<!-- -->` or `<...>`. The page's own
//!     text `a<b>c` would lose its `b` - `text-vide` would keep it, because the
//!     pipeline escaped `<` to `&lt;` before segmenting, and no tag is left for
//!     it to see.
//!   * `text-vide` (not `bioneer`) also skips anything inside `&...;`. The
//!     escaping is what put those entities there in the first place - `&` in the
//!     page's text became `&amp;`, whose `amp` is a word it then had to skip.
//!
//! So the three characters that could open either - `&`, `<`, `>` - are replaced
//! with one character that is neither a letter nor a digit before the text is
//! handed over, which is the whole of what escaping was buying. One character
//! stands for one character, so no position shifts and nothing has to be counted
//! back through entities afterwards: a segment indexes the page's text directly.
//!
//! A ligature is the other thing an answer has to survive. `text-vide` and
//! `bioneer` count a word in *letters*, and the one glyph a typesetter drew for
//! "fi" is two of them, so a ligature character is spelled out before the words
//! are looked for and the marks are read back onto the characters that are really
//! there. A glyph the fixation reaches into is marked whole: it is one outline and
//! cannot be drawn half dark.
//!
//! One place the crate is not a port of the library is stated where it is put
//! right: `bioneer` misreads the table's fallback for a word longer than the
//! table, and `LONG_TAIL` says how (`long_words`). A URL is faded the way the
//! pipeline faded it.

use std::sync::OnceLock;

use bioneer::Bionify;

use crate::font::program::ligature_letters;

/// How much of its strength the rest of a word is drawn at, by default.
///
/// The fixation points are the text as the document set it and everything around
/// them is faded, rather than the fixation points being emboldened: these fonts
/// are rebuilt from the page's own outlines and have one weight, so `bold` is the
/// browser's synthetic emboldening, which smears the letterforms of a text face
/// and crowds the letter after the last bold one. Fading costs nothing, works on
/// any colour of text (it is an opacity, not a grey), and leaves the glyphs
/// themselves untouched.
///
/// A half is the balance the eye wants: dark enough that the whole word is still
/// comfortably readable, light enough that the fixation points lead.
pub const BIONIC_DIM: f32 = 0.5;

/// The faintest a word's remainder may be drawn: any less and it is not there.
pub const BIONIC_MIN_DIM: f32 = 0.05;

/// The dim actually used to draw a page: the caller's number when it is one, and
/// the default when it is not. Clamped rather than rejected - a host offering a
/// slider cannot send a page to opacity 0 by accident.
pub fn bionic_dim(value: Option<f32>) -> f32 {
    match value {
        Some(v) if v.is_finite() => v.clamp(BIONIC_MIN_DIM, 1.0),
        _ => BIONIC_DIM,
    }
}

/// Which of a page's words bionic reading marks.
///
/// The fixation table is about letters, not about meaning, and a page is not
/// always prose: a formula's `dx`, a table's `2024`, an identifier like `mHC`
/// are words to the segmenter and not to a reader, and fading part of one makes
/// it harder to read rather than easier. The scope is what decides.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Scope {
    /// Only the words the English dictionary knows.
    ///
    /// This is the default, because prose is mostly dictionary words and a
    /// formula is mostly not. A word the list does not know - an identifier, a
    /// number, a word in a script the list does not cover - is left exactly as
    /// the document set it. `build.rs` says where the list comes from.
    #[default]
    Common,
    /// Every word long enough to have a tail: four letters or more.
    ///
    /// A formula is full of short words - `dx`, `sin`, `log`, a lone `x` - and
    /// so is prose; this leaves both alone. Three letters or fewer is the cut
    /// because that is where the fixation point is most of the word already,
    /// and because `sin` and `log` are words of that length.
    Short,
    /// Every word, which is what bionic reading usually means.
    All,
}

impl Scope {
    /// The scope a host's number names.
    ///
    /// 0 is [`Scope::Common`], 1 [`Scope::Short`] and 2 [`Scope::All`]; a number
    /// this core does not know is the default rather than an error, because a
    /// host newer than the core must not be able to change what a page looks
    /// like in a way the core cannot describe.
    pub fn from_code(code: u32) -> Self {
        match code {
            1 => Self::Short,
            2 => Self::All,
            _ => Self::Common,
        }
    }

    /// The scope a name in the environment names: `common`, `short` or `all`.
    pub fn from_name(name: &str) -> Option<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "common" => Some(Self::Common),
            "short" => Some(Self::Short),
            "all" => Some(Self::All),
            _ => None,
        }
    }
}

/// The length at which [`Scope::Short`] starts marking: words of three letters
/// or fewer are left alone.
const LONG_ENOUGH: usize = 4;

/// The words [`Scope::Common`] knows, one per line and sorted, so a lookup is a
/// binary search.
///
/// The 10,000 most frequent English words in Google Books, from the
/// `common-words-all` crate (MIT), filtered to the alphabetic entries and
/// folded to lower case by `build.rs`. The data is a build dependency rather
/// than a file here: cargo fetches the crate like any other dependency, and the
/// wasm carries only the sorted words, not the crate's records and frequencies.
const COMMON_WORDS: &str = include_str!(concat!(env!("OUT_DIR"), "/common-words.txt"));

/// The dictionary, split once: a page asks it about every word it draws.
fn common_words() -> &'static [&'static str] {
    static WORDS: OnceLock<Vec<&'static str>> = OnceLock::new();
    WORDS.get_or_init(|| COMMON_WORDS.lines().collect())
}

/// One stretch of text, marked as a fixation point or not.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Segment {
    /// Whether this stretch of text is a word's fixation point.
    pub fixation: bool,
    /// The text itself, exactly as it was given.
    pub text: String,
    /// How many characters of the input it covers: one positioned glyph each.
    pub chars: usize,
}

/// What `&`, `<` and `>` are replaced with before the words are looked for.
///
/// Not a letter, not a digit - so it separates words - and not one of the three
/// characters that could be read as markup, which is the only thing it has to
/// avoid to keep a word from hiding behind it.
const PLACEHOLDER: char = '\u{fffd}';

/// A character, with the ones that could open markup taken out of the way.
fn guarded(c: char) -> char {
    if matches!(c, '&' | '<' | '>') {
        PLACEHOLDER
    } else {
        c
    }
}

/// Whether a stretch is nothing but whitespace, the way JavaScript's `trim`
/// asks the question.
///
/// A whitespace-only stretch is between two words rather than in one, and fading
/// it would be an attribute that draws no pixel, so the caller marks it apart
/// from a stretch that is simply not a fixation point. JavaScript also trims a
/// zero-width no-break space, which is not Unicode whitespace - `&` never writes
/// one, but the two sides have to agree on where the boundary is.
pub fn blank(text: &str) -> bool {
    text.chars().all(|c| c.is_whitespace() || c == '\u{feff}')
}

/// The text with every ligature spelled out, and the input behind each letter.
struct Spelled {
    /// The text with every ligature spelled out, ready for `bioneer`.
    marked: String,
    /// For every character of the input, the bytes it starts and ends at.
    bounds: Vec<(usize, usize)>,
    /// For every character of `marked`, which character of the input it is.
    owner: Vec<usize>,
}

/// Spell out every ligature, so that a word is counted in the letters a reader
/// sees rather than in the glyphs the typesetter drew.
fn spell_out(text: &str) -> Spelled {
    let mut marked = String::with_capacity(text.len());
    let mut bounds = Vec::new();
    let mut owner = Vec::new();
    let mut buf = [0u8; 4];
    for (at, c) in text.char_indices() {
        let written = match ligature_letters(c as u32) {
            Some(letters) => letters,
            None => c.encode_utf8(&mut buf),
        };
        for letter in written.chars() {
            marked.push(guarded(letter));
        }
        bounds.push((at, at + c.len_utf8()));
        // A ligature writes two characters for the one it is, everything else one.
        for _ in 0..written.chars().count() {
            owner.push(bounds.len() - 1);
        }
    }
    Spelled {
        marked,
        bounds,
        owner,
    }
}

/// The last word length the fixation table has an entry for.
const LONGEST_TABLE_WORD: usize = 48;

/// How much of a word longer than the table is left unfaded: past 48 letters the
/// table's own trend is continued, and a word keeps everything up to its ninth
/// letter from the end.
///
/// `bioneer` does not continue it. Its port reads the fallback as the number of
/// letters to *keep* where `text-vide` reads it as the number to skip past, so
/// where the table would hold 40 letters of a 48-letter word and 40 of a
/// 49-letter one, the crate holds nine of a 51-letter one. A long word is a URL
/// or an identifier rather than an absurdity, so the marks are put back to what
/// the table says (`long_words`), and `segments` is then the pipeline's answer
/// whatever the crate does here.
const LONG_TAIL: usize = 9;

/// A character a word can be made of: the crate's own `\p{L}|\p{Nd}`, as close
/// as the standard library comes to it.
///
/// `is_alphabetic` is the Unicode `Alphabetic` property, a little wider than the
/// letters, and `is_numeric` is the whole number category where the crate means
/// the decimal digits. The difference can only tell when it makes a run cross the
/// table's own length, and then it moves a mark by a letter at most.
fn word_char(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric()
}

/// Whether the last character of `text` is one a word can go on from.
///
/// The caller holds back a run whose text ends in one of these, because that
/// word may be finished in the next run - a font or colour change inside a word
/// is a second text object - and how much of *this* run is a fixation point
/// depends on the whole word's length. A run ending in a separator or a space
/// ends its word, so it needs no holding.
pub fn ends_in_word(text: &str) -> bool {
    text.chars().next_back().is_some_and(word_char)
}

/// Walk the words of `chars`, handing each its character range.
///
/// The long-word correction and the scope filter have to agree about where a
/// word begins and ends, which is what this is. The scope filter also needs the
/// stretches between the words, so it walks those itself.
fn each_word(chars: &[char], mut each: impl FnMut(usize, usize)) {
    let mut i = 0;
    while i < chars.len() {
        if !word_char(chars[i]) {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < chars.len() && word_char(chars[j]) {
            j += 1;
        }
        each(i, j);
        i = j;
    }
}

/// Put the marks of every word longer than the table back to what the table says.
fn long_words(text: &str, fixed: &mut [bool]) {
    let chars: Vec<char> = text.chars().collect();
    each_word(&chars, |i, j| {
        let len = j - i;
        if len > LONGEST_TABLE_WORD {
            for (n, at) in (i..j).enumerate() {
                fixed[at] = n < len - LONG_TAIL;
            }
        }
    });
}

/// Whether the dictionary knows this word.
///
/// The answer is about the word a reader sees, so the comparison is lower-case
/// and the letters of a ligature have already been spelled out. A token with a
/// digit in it is not a dictionary word however it is spelled - `Domain2i` and
/// `T0` are identifiers - which is most of what keeps a formula out of the
/// marks. A word in a script the list does not cover (Greek in a formula, a
/// Chinese label) is simply not found, and is left alone for the same reason.
fn common(word: &[char]) -> bool {
    if word.is_empty() || word.iter().any(|c| !c.is_alphabetic()) {
        return false;
    }
    let mut lower = String::with_capacity(word.len());
    for c in word {
        lower.extend(c.to_lowercase());
    }
    common_words().binary_search(&lower.as_str()).is_ok()
}

/// A stretch of characters that are nothing but white space, the way [`blank`]
/// asks the question of a string.
fn blank_chars(chars: &[char]) -> bool {
    chars.iter().all(|c| c.is_whitespace() || *c == '\u{feff}')
}

/// Leave the words `scope` does not cover exactly as the page set them.
///
/// A fixation point is a part drawn at full strength, so a word whose every
/// letter is one is the word the document drew: no `fill-opacity`, no change to
/// the text, and no change to a position - `write_run` only uses the answer to
/// decide where a `<tspan>` ends.
///
/// The stretches *between* words need an answer too, because bionic reading
/// fades them with the tail of the word before. That is right in prose and
/// wrong in a formula, where a faded `=` or `+` is a mark bionic reading never
/// meant to make. A separator takes no fade when either word beside it is left
/// alone; a blank one is its own `<tspan>` either way and no ink turns on which
/// way it goes.
fn scope_words(text: &str, scope: Scope, fixed: &mut [bool]) {
    if scope == Scope::All {
        return;
    }
    let chars: Vec<char> = text.chars().collect();
    let mut words: Vec<(usize, usize, bool)> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !word_char(chars[i]) {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < chars.len() && word_char(chars[j]) {
            j += 1;
        }
        let keep = match scope {
            Scope::Common => common(&chars[i..j]),
            Scope::Short => j - i >= LONG_ENOUGH,
            Scope::All => true,
        };
        if !keep {
            fixed[i..j].fill(true);
        }
        words.push((i, j, keep));
        i = j;
    }
    if words.is_empty() {
        // There is no word to mark: a run of nothing but symbols is not bionic
        // reading's to fade.
        fixed.fill(true);
        return;
    }
    let mut at = 0;
    for (n, &(start, end, keep)) in words.iter().enumerate() {
        if start > at && !blank_chars(&chars[at..start]) {
            let before = n == 0 || words[n - 1].2;
            if !(before && keep) {
                fixed[at..start].fill(true);
            }
        }
        at = end;
    }
    if at < chars.len() && !blank_chars(&chars[at..]) && !words[words.len() - 1].2 {
        fixed[at..].fill(true);
    }
}

/// Walk one stretch of the markup, marking the letters it covers.
fn mark(stretch: &str, fixation: bool, at: &mut usize, letters: &mut [bool]) {
    for _ in 0..stretch.chars().count() {
        if *at >= letters.len() {
            return;
        }
        if fixation {
            letters[*at] = true;
        }
        *at += 1;
    }
}

/// The text as a run of stretches, each marked as a fixation point or not.
///
/// Concatenating `text` reproduces the input exactly; `chars` sums to the number
/// of characters in it. The caller checks that sum against the glyphs it has, so
/// a future `bioneer` that marks characters differently degrades to plain text
/// rather than to fixation points in the wrong places.
pub fn segments(text: &str) -> Vec<Segment> {
    segments_with(text, Scope::All)
}

/// The same, marking only the words `scope` covers.
///
/// A word the scope leaves out is not cut out of the output - the text and its
/// positions are the page's - it is marked as one fixation point from end to
/// end, which is the same as being drawn exactly as the document set it.
pub fn segments_with(text: &str, scope: Scope) -> Vec<Segment> {
    if text.is_empty() {
        return Vec::new();
    }
    let Spelled {
        marked,
        bounds,
        owner,
    } = spell_out(text);

    // The marks arrive in the order of the characters they cover, so one cursor
    // walks them: the stretch `bioneer` wrote is a run of characters of the
    // spelled-out text, and `owner` says which character of the input each is.
    let markup = marked.bionify();
    let mut letters = vec![false; owner.len()];
    let mut at = 0usize;
    let mut cursor = 0usize;
    while let Some(open) = markup[cursor..].find("<b>") {
        let open = cursor + open;
        let Some(close) = markup[open + 3..].find("</b>") else {
            break;
        };
        let close = open + 3 + close;
        mark(&markup[cursor..open], false, &mut at, &mut letters);
        mark(&markup[open + 3..close], true, &mut at, &mut letters);
        cursor = close + 4;
    }
    mark(&markup[cursor..], false, &mut at, &mut letters);
    long_words(&marked, &mut letters);
    // After the long-word correction: a word the scope leaves out is left whole
    // however long it is, and the correction would otherwise fade its tail.
    scope_words(&marked, scope, &mut letters);

    // A glyph the fixation reaches into is marked whole, so a letter of a
    // ligature marks the one character the ligature is.
    let mut fixed = vec![false; bounds.len()];
    for (at, marked) in letters.iter().enumerate() {
        if *marked {
            fixed[owner[at]] = true;
        }
    }

    let mut out = Vec::new();
    let mut i = 0;
    while i < fixed.len() {
        let mut j = i;
        while j < fixed.len() && fixed[j] == fixed[i] {
            j += 1;
        }
        out.push(Segment {
            fixation: fixed[i],
            text: text[bounds[i].0..bounds[j - 1].1].to_string(),
            chars: j - i,
        });
        i = j;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_of(segments: &[Segment]) -> String {
        segments.iter().map(|s| s.text.as_str()).collect()
    }

    fn fixed(segments: &[Segment]) -> String {
        segments
            .iter()
            .filter(|s| s.fixation && !blank(&s.text))
            .map(|s| s.text.as_str())
            .collect()
    }

    fn faded(segments: &[Segment]) -> String {
        segments
            .iter()
            .filter(|s| !s.fixation && !blank(&s.text))
            .map(|s| s.text.as_str())
            .collect()
    }

    /// A segment covers the input and nothing else, in order, however it is cut.
    fn accounted_for(text: &str) {
        let segs = segments(text);
        assert_eq!(text_of(&segs), text);
        assert_eq!(
            segs.iter().map(|s| s.chars).sum::<usize>(),
            text.chars().count()
        );
    }

    /// The same, for a scope: leaving words alone cuts the text differently, but
    /// it still covers every character exactly once.
    fn accounted_for_scope(text: &str, scope: Scope) {
        let segs = segments_with(text, scope);
        assert_eq!(text_of(&segs), text);
        assert_eq!(
            segs.iter().map(|s| s.chars).sum::<usize>(),
            text.chars().count()
        );
    }

    #[test]
    fn a_word_keeps_its_first_letters() {
        let segs = segments("Hello, world!");
        accounted_for("Hello, world!");
        assert_eq!(fixed(&segs), "Helwor");
    }

    /// The words `text-vide` marks, on its own example paragraph: the table is
    /// indexed by length, so a five-letter word keeps more of itself than a
    /// four-letter one and a long one keeps a fixed handful.
    #[test]
    fn the_marks_are_the_ones_text_vide_makes() {
        let text = "Bionic Reading is a new method facilitating the reading process.";
        accounted_for(text);
        assert_eq!(
            fixed(&segments(text)),
            "BionReadiinemethfacilitatithreadiproce"
        );
    }

    /// The table gives out at 48 letters, and the word keeps what the table's
    /// own trend says it should: `text-vide` marks 40 of a 48-letter word, 40 of
    /// a 49-letter one and 51 of a 60-letter one.
    #[test]
    fn a_word_longer_than_the_table_keeps_its_fixed_handful() {
        for (len, kept) in [(48, 40), (49, 40), (50, 41), (60, 51), (152, 143)] {
            let text = "a".repeat(len);
            accounted_for(&text);
            assert_eq!(fixed(&segments(&text)), "a".repeat(kept), "{len} letters");
        }
    }

    /// A word between two of them is still a word: `<b>` looks like a tag and
    /// `&amp;` looks like an entity, and a reader sees neither.
    #[test]
    fn markup_is_only_text() {
        let text = "x <b>hello</b> y";
        accounted_for(text);
        assert_eq!(fixed(&segments(text)), "hel");
    }

    /// A run that ends in one of these may be a word's first half, and the
    /// caller holds it back until the rest arrives. A separator ends the word
    /// there and then, so nothing can follow it.
    #[test]
    fn a_word_can_go_on_from_a_letter_or_a_digit() {
        assert!(ends_in_word("Incorpora"));
        assert!(ends_in_word("2"));
        assert!(!ends_in_word("Incorpora-"));
        assert!(!ends_in_word("word "));
        assert!(!ends_in_word(", "));
        assert!(!ends_in_word(""));
    }

    /// A ligature is one glyph and two letters. `office` is six letters, so the
    /// fixation point reaches into the `fi` - and the glyph, being one outline,
    /// is marked whole rather than half dark.
    #[test]
    fn a_ligature_is_marked_as_the_letters_it_stands_for() {
        let text = "o\u{fb01}ce";
        accounted_for(text);
        assert_eq!(fixed(&segments(text)), "o\u{fb01}");
    }

    /// A stretch of nothing but whitespace is its own segment, and the caller is
    /// told so rather than being handed a fade: it is between two words, not in
    /// one, and a space is a pixel either way. A run that opens with a space
    /// before a word whose fixation reaches its first letter is where it happens.
    #[test]
    fn a_lone_space_is_its_own_stretch() {
        let segs = segments(" ahoj");
        assert_eq!(segs.len(), 3);
        assert!(!segs[0].fixation && segs[0].chars == 1);
        assert!(blank(&segs[0].text));
        assert!(!blank(" a"));
        assert!(fixed(&segs) == "aho");
    }

    /// The dim is clamped, and a host that says nothing gets the default.
    #[test]
    fn the_dim_is_clamped() {
        assert_eq!(bionic_dim(None), BIONIC_DIM);
        assert_eq!(bionic_dim(Some(f32::NAN)), BIONIC_DIM);
        assert_eq!(bionic_dim(Some(0.0)), BIONIC_MIN_DIM);
        assert_eq!(bionic_dim(Some(4.0)), 1.0);
        assert_eq!(bionic_dim(Some(0.35)), 0.35);
    }

    /// The same text, marked three ways. `All` marks every word; `Short` leaves
    /// the three-letter and shorter ones whole, which is where `dx` and `sin`
    /// live; `Common` also leaves `2024` whole, because a number is not a
    /// dictionary word.
    #[test]
    fn a_scope_leaves_the_words_it_does_not_cover_alone() {
        let text = "the 2024 dx coefficient";
        for scope in [Scope::Common, Scope::Short, Scope::All] {
            accounted_for_scope(text, scope);
        }
        // `bioneer` does not mark a word with no letter in it, so `2024` is
        // faded whole and its space goes with it; `Common` leaves it, and the
        // numbers and the space around them are the difference the mode makes.
        assert_eq!(faded(&segments_with(text, Scope::All)), "e 2024 x nt");
        assert_eq!(faded(&segments_with(text, Scope::Short)), " 2024 nt");
        assert_eq!(faded(&segments_with(text, Scope::Common)), "e nt");
        // The words left alone keep every letter: `2024` and `dx` are a fixation
        // stretch from end to end, and `the` and `coefficient` are marked around
        // them.
        assert_eq!(
            fixed(&segments_with(text, Scope::Common)),
            "th2024dxcoefficie"
        );
    }

    /// A dictionary is case-insensitive: a word at the start of a sentence, or a
    /// heading in capitals, is the same word.
    #[test]
    fn a_common_word_is_matched_whatever_its_case() {
        let text = "INCORPORATE incorporate";
        accounted_for_scope(text, Scope::Common);
        assert_eq!(faded(&segments_with(text, Scope::Common)), "TE te");
    }

    /// A digit makes an identifier out of a word: `T0` and `Domain2i` are not
    /// spellings of anything, so `Common` leaves them alone. `Short` leaves them
    /// alone too when they are short enough; `All` marks them like any word.
    #[test]
    fn a_word_with_a_digit_is_not_a_dictionary_word() {
        let text = "42 T0 mHC";
        accounted_for_scope(text, Scope::Common);
        assert_eq!(faded(&segments_with(text, Scope::Common)), "");
        // `42` and `T0` are two letters, `mHC` is three: every one of them is in
        // the fixation stretch, whole.
        assert_eq!(
            fixed(&segments_with(text, Scope::Common)),
            "42T0mHC"
        );
        assert_eq!(faded(&segments_with(text, Scope::All)), "42 0 C");
    }

    /// A word the list does not know is left alone, and the words around it are
    /// not: `submanifold` is missing from the 10,000 common words while
    /// `coefficient` is among them, which is exactly the line the scope draws.
    #[test]
    fn a_word_the_dictionary_does_not_know_is_left_alone() {
        let text = "submanifold coefficient";
        accounted_for_scope(text, Scope::Common);
        assert_eq!(
            fixed(&segments_with(text, Scope::Common)),
            "submanifoldcoefficie"
        );
        assert_eq!(faded(&segments_with(text, Scope::Common)), "nt");
    }

    /// The list is English, so a script it does not cover is not guessed at:
    /// every character of a Chinese label is left alone rather than marked by a
    /// table that measures letters it has never seen.
    #[test]
    fn a_script_the_dictionary_does_not_cover_is_left_alone() {
        let text = "内部综合评估";
        accounted_for_scope(text, Scope::Common);
        assert_eq!(faded(&segments_with(text, Scope::Common)), "");
        assert_eq!(fixed(&segments_with(text, Scope::Common)), text);
        // `All` still marks it, as it always did.
        assert_eq!(faded(&segments_with(text, Scope::All)), "评估");
    }

    /// The scope a host names by number, and the one a shell names by name. An
    /// unknown number is the default rather than an error: a host newer than the
    /// core must not be able to ask for a page the core cannot describe.
    #[test]
    fn a_scope_has_a_number_and_a_name() {
        assert_eq!(Scope::from_code(0), Scope::Common);
        assert_eq!(Scope::from_code(1), Scope::Short);
        assert_eq!(Scope::from_code(2), Scope::All);
        assert_eq!(Scope::from_code(7), Scope::Common);
        assert_eq!(Scope::default(), Scope::Common);
        assert_eq!(Scope::from_name("common"), Some(Scope::Common));
        assert_eq!(Scope::from_name(" Short "), Some(Scope::Short));
        assert_eq!(Scope::from_name("ALL"), Some(Scope::All));
        assert_eq!(Scope::from_name("sometimes"), None);
    }

    /// The list is sorted, because the lookup is a binary search, and it says
    /// both yes and no to words that are worth saying it about. A generated list
    /// that lost a line or gained a blank one would fail here rather than quietly
    /// marking the wrong words.
    #[test]
    fn the_dictionary_is_sorted_and_answers() {
        let words = common_words();
        assert!(words.len() > 8_000, "{} words", words.len());
        assert!(
            words.windows(2).all(|pair| pair[0] < pair[1]),
            "sorted and unique"
        );
        for known in ["the", "incorporate", "coefficient", "word"] {
            assert!(words.binary_search(&known).is_ok(), "{known}");
        }
        for unknown in ["dx", "mhc", "t0", "domain2i", "submanifold", "eigenvalue"] {
            assert!(words.binary_search(&unknown).is_err(), "{unknown}");
        }
    }
}
