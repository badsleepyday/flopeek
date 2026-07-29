//! Source-text decoding shared by every strict-native parser.
//!
//! Flopeek's JavaScript scanner reads source using Node's UTF-8 text decoding,
//! which replaces malformed byte sequences instead of rejecting the entire
//! repository. Native parsing must preserve that availability contract: a
//! malformed legacy/vendor source file can produce parser diagnostics, but it
//! must not turn an otherwise complete repository scan into a failed scan.

use std::fs;
use std::io;
use std::path::Path;

/// Read source with deterministic UTF-8 replacement semantics.
///
/// I/O failures remain errors. Only malformed UTF-8 is recoverable because
/// source scanners operate on text and the compatibility contract represents
/// such bytes as U+FFFD, matching Node's `fs.readFileSync(path, "utf8")`.
pub fn read_source_text(path: impl AsRef<Path>) -> Result<String, io::Error> {
    let bytes = fs::read(path)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::read_source_text;
    use std::fs;

    #[test]
    fn replaces_malformed_utf8_without_rejecting_the_file() {
        let directory =
            std::env::temp_dir().join(format!("flopeek-native-source-text-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join("legacy.php");
        fs::write(&source, b"<?php \x80 function legacy() {}\n").unwrap();

        assert_eq!(
            read_source_text(&source).unwrap(),
            "<?php \u{fffd} function legacy() {}\n"
        );

        fs::remove_dir_all(directory).unwrap();
    }
}
