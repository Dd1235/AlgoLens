package main

import "strings"

// Mirrors server/search/tokenize.js. DSA-relevant words deliberately kept
// out of the stopword set: "two", "one", "all", "any", "more", "most",
// "same", "only", "other".
var stopwords = map[string]struct{}{
	"a": {}, "an": {}, "the": {}, "and": {}, "or": {}, "but": {}, "if": {},
	"then": {}, "of": {}, "for": {}, "to": {}, "in": {}, "on": {}, "at": {},
	"by": {}, "with": {}, "from": {}, "as": {}, "is": {}, "are": {}, "was": {},
	"were": {}, "be": {}, "been": {}, "being": {}, "it": {}, "its": {}, "this": {},
	"that": {}, "these": {}, "those": {}, "you": {}, "your": {}, "we": {}, "our": {},
	"they": {}, "them": {}, "their": {}, "i": {}, "me": {}, "my": {}, "have": {},
	"has": {}, "had": {}, "do": {}, "does": {}, "did": {}, "so": {}, "not": {},
	"no": {}, "yes": {}, "than": {}, "into": {}, "out": {}, "up": {}, "down": {},
	"over": {}, "under": {}, "may": {}, "can": {}, "will": {}, "would": {},
	"should": {}, "could": {}, "given": {}, "return": {}, "such": {}, "each": {}, "some": {},
}

// tokenize lowercases, replaces non-[a-z0-9] with space, splits on whitespace,
// and drops stopwords. Output must match the JS tokenizer byte-for-byte on
// equivalent input.
func tokenize(text string) []string {
	if text == "" {
		return nil
	}
	out := make([]string, 0, 16)
	var buf strings.Builder
	flush := func() {
		if buf.Len() == 0 {
			return
		}
		t := buf.String()
		if _, stop := stopwords[t]; !stop {
			out = append(out, t)
		}
		buf.Reset()
	}
	for i := 0; i < len(text); i++ {
		c := text[i]
		switch {
		case c >= 'a' && c <= 'z':
			buf.WriteByte(c)
		case c >= '0' && c <= '9':
			buf.WriteByte(c)
		case c >= 'A' && c <= 'Z':
			buf.WriteByte(c + ('a' - 'A'))
		default:
			flush()
		}
	}
	flush()
	return out
}
