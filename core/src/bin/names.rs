// Print the glyph names a program carries, for comparison with the reader this
// replaces.
use webpdf_core::font::names::{cff_names, type1_names};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&args[1]).unwrap();
    let names = type1_names(&bytes).or_else(|| cff_names(&bytes));
    match names {
        Some(n) => {
            println!("{} names", n.names.len());
            println!("  names 44..50 {:?}", &n.names[44.min(n.names.len())..50.min(n.names.len())]);
            println!(
                "  index of fi {:?} fl {:?} z {:?}",
                n.names.iter().position(|x| x == "fi"),
                n.names.iter().position(|x| x == "fl"),
                n.names.iter().position(|x| x == "z")
            );
            println!("  encoding {:?}", &n.encoding[..n.encoding.len().min(6)]);
            std::fs::write(&args[2], n.names.join("\n")).unwrap();
        }
        None => println!("no names"),
    }
}
