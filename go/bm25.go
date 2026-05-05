package main

import (
	"math"
	"sort"
	"strings"
)

// Problem mirrors the JSON shape on disk and the in-memory shape in the JS
// service. Only the fields BM25 + the gRPC response need are stored.
type Problem struct {
	ID         string   `json:"id"`
	Title      string   `json:"title"`
	Slug       string   `json:"slug"`
	Difficulty string   `json:"difficulty"`
	Statement  string   `json:"statement"`
	SourceURL  string   `json:"source_url"`
	Platform   string   `json:"platform"`
	Tags       []string `json:"tags"`
	Patterns   []string `json:"patterns"`
}

type ScoredDoc struct {
	DocIndex      int
	Score         float64
	MatchedTerms  []string
}

// Bm25Index mirrors server/search/bm25.js exactly. RSJ IDF, k1 = 1.5, b =
// 0.75, length normalization on the smoothed dl/avgdl ratio.
type Bm25Index struct {
	Problems []Problem

	k1, b, avgdl float64

	docTermCounts []map[string]int
	docLengths    []int
	df            map[string]int
	idf           map[string]float64
	postings      map[string][]int
}

func problemText(p Problem) string {
	var b strings.Builder
	b.Grow(len(p.Title) + len(p.Statement) + 64)
	b.WriteString(p.Title)
	b.WriteByte(' ')
	b.WriteString(p.Statement)
	for _, t := range p.Tags {
		b.WriteByte(' ')
		b.WriteString(t)
	}
	for _, t := range p.Patterns {
		b.WriteByte(' ')
		b.WriteString(t)
	}
	return b.String()
}

func NewBm25Index(problems []Problem) *Bm25Index {
	idx := &Bm25Index{
		Problems:      problems,
		k1:            1.5,
		b:             0.75,
		docTermCounts: make([]map[string]int, len(problems)),
		docLengths:    make([]int, len(problems)),
		df:            map[string]int{},
		idf:           map[string]float64{},
		postings:      map[string][]int{},
	}

	totalLen := 0
	for i, p := range problems {
		toks := tokenize(problemText(p))
		counts := make(map[string]int, len(toks))
		for _, t := range toks {
			counts[t]++
		}
		idx.docTermCounts[i] = counts
		idx.docLengths[i] = len(toks)
		totalLen += len(toks)

		for term := range counts {
			idx.df[term]++
			idx.postings[term] = append(idx.postings[term], i)
		}
	}

	N := float64(len(problems))
	if N > 0 {
		idx.avgdl = float64(totalLen) / N
	}
	for term, df := range idx.df {
		idx.idf[term] = math.Log(1.0 + (N-float64(df)+0.5)/(float64(df)+0.5))
	}
	return idx
}

func (idx *Bm25Index) Avgdl() float64 { return idx.avgdl }

func (idx *Bm25Index) Search(query string, k int) []ScoredDoc {
	if k <= 0 {
		return nil
	}
	qtokens := tokenize(query)
	if len(qtokens) == 0 {
		return nil
	}

	scoreByDoc := map[int]float64{}
	matchedByDoc := map[int][]string{}

	for _, term := range qtokens {
		idf, ok := idx.idf[term]
		if !ok {
			continue
		}
		docs := idx.postings[term]
		if docs == nil {
			continue
		}
		for _, doc := range docs {
			tf := float64(idx.docTermCounts[doc][term])
			if tf == 0 {
				continue
			}
			dl := float64(idx.docLengths[doc])
			norm := 1.0 - idx.b
			if idx.avgdl > 0 {
				norm += idx.b * (dl / idx.avgdl)
			}
			contribution := idf * (tf * (idx.k1 + 1.0)) / (tf + idx.k1*norm)
			if contribution <= 0 {
				continue
			}
			scoreByDoc[doc] += contribution
			matchedByDoc[doc] = append(matchedByDoc[doc], term)
		}
	}

	hits := make([]ScoredDoc, 0, len(scoreByDoc))
	for doc, score := range scoreByDoc {
		hits = append(hits, ScoredDoc{
			DocIndex:     doc,
			Score:        score,
			MatchedTerms: matchedByDoc[doc],
		})
	}
	sort.Slice(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	if len(hits) > k {
		hits = hits[:k]
	}
	return hits
}
