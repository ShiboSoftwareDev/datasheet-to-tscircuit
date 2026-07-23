const negative_words = new Set(["negative", "neg", "minus"])
const positive_words = new Set(["positive", "pos", "plus"])

/**
 * Normalizes explicit polarity spellings without erasing their meaning.
 *
 * Circuit JSON may retain a selector-safe alias such as IN_NEG or IN_POS while
 * omitting a punctuation-bearing datasheet alias such as IN− or IN+. Keep this
 * separate from general text normalization so that positive and negative pins
 * can never collapse to the same label.
 */
export function normalizeElectricalPinLabel(value: string): string {
  const with_explicit_polarity = value
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\+/g, " pos ")
    .replace(/[−–—﹣]/g, " neg ")
    .replace(/-$/g, " neg ")

  const tokens = with_explicit_polarity.split(/[^a-z0-9]+/).filter(Boolean)
  return tokens
    .map((token, index) => {
      if (negative_words.has(token)) return "neg"
      if (positive_words.has(token)) return "pos"
      if (index === tokens.length - 1 && tokens.length > 1 && token === "n") return "neg"
      if (index === tokens.length - 1 && tokens.length > 1 && token === "p") return "pos"
      return token
    })
    .join("")
}
