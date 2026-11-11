/**
 * Rendering-only typography helpers. Stored titles and content keep their plain spaces; these run where text is drawn.
 */

const NBSP = ' ';

/**
 * Binds a spaced en dash to the word before it, so a narrow line breaks after the dash and never opens with one
 * ("Team Brain –" / "Shared Context", not "Team Brain" / "– Shared Context"). The no-break space is read as an
 * ordinary space by search, copy-and-paste and the agent corpus extractor (`\s` matches it).
 */
export function bindDash(text: string): string {
  return text.replaceAll(' – ', `${NBSP}– `);
}

/**
 * Binds every space in a short label (an employer, a date range) so it wraps as one unit and never splits mid-name
 * ("John / Deere"). Keep it to labels that fit a narrow line; the no-break space is read as an ordinary space by
 * search, copy-and-paste and the agent corpus extractor.
 */
export function keepTogether(text: string): string {
  return text.replaceAll(' ', NBSP);
}
