"use strict";

// Flopeek's public graph order is a protocol contract, never the machine's
// ambient locale. Keep this aligned with the Rust ICU collator in
// `native/flopeek-core`: English default sort, variant sensitivity, visible
// punctuation, no numeric collation, and no case-first override.
const COLLATION_LOCALE = "en";
const COLLATION_OPTIONS = Object.freeze({
  usage: "sort",
  sensitivity: "variant",
  ignorePunctuation: false,
  numeric: false,
  caseFirst: "false",
});
const collator = new Intl.Collator(COLLATION_LOCALE, COLLATION_OPTIONS);

function compareCollation(left, right) {
  return collator.compare(String(left), String(right));
}

module.exports = { COLLATION_LOCALE, COLLATION_OPTIONS, compareCollation };
