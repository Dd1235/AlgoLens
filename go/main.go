package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"time"

	pb "algolens/proto"

	"google.golang.org/grpc"
)

type searchServer struct {
	pb.UnimplementedSearchServer
	idx *Bm25Index
}

func (s *searchServer) SearchTopK(_ context.Context, req *pb.SearchRequest) (*pb.SearchResponse, error) {
	k := int(req.GetK())
	if k <= 0 {
		k = 10
	}
	offset := int(req.GetOffset())
	if offset < 0 {
		offset = 0
	}

	t0 := time.Now()
	hits, total := s.idx.Search(req.GetQuery(), k, offset)
	scoringMs := float64(time.Since(t0)) / float64(time.Millisecond)

	resp := &pb.SearchResponse{
		ScoringLatencyMs: scoringMs,
		Ranker:           "bm25-go",
		CorpusSize:       int32(len(s.idx.Problems)),
		Total:            int32(total),
	}
	for _, h := range hits {
		p := s.idx.Problems[h.DocIndex]
		resp.Hits = append(resp.Hits, &pb.Hit{
			Id:           p.ID,
			Title:        p.Title,
			Slug:         p.Slug,
			Difficulty:   p.Difficulty,
			Tags:         p.Tags,
			Statement:    p.Statement,
			Patterns:     p.Patterns,
			SourceUrl:    p.SourceURL,
			Score:        h.Score,
			MatchedTerms: h.MatchedTerms,
		})
	}
	return resp, nil
}

func main() {
	addr := flag.String("addr", "0.0.0.0:50051", "gRPC listen address")
	corpusRoot := flag.String("corpus", "../data/problemset_llm",
		"corpus root with leetcode/ + cses/ subdirs (relative to cwd)")
	flag.Parse()

	platforms := []string{"leetcode", "cses"}

	fmt.Printf("loading corpus from %s ...\n", *corpusRoot)
	tLoad := time.Now()
	problems, err := LoadCorpus(*corpusRoot, platforms)
	if err != nil {
		log.Fatalf("load corpus: %v", err)
	}
	loadMs := float64(time.Since(tLoad)) / float64(time.Millisecond)
	if len(problems) == 0 {
		fmt.Fprintf(os.Stderr, "no problems loaded; expected json under %s/{leetcode,cses}\n", *corpusRoot)
		os.Exit(1)
	}

	tBuild := time.Now()
	idx := NewBm25Index(problems)
	buildMs := float64(time.Since(tBuild)) / float64(time.Millisecond)
	fmt.Printf("loaded %d docs in %.1f ms; built bm25 in %.1f ms (avgdl=%.2f)\n",
		len(problems), loadMs, buildMs, idx.Avgdl())

	lis, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	srv := grpc.NewServer()
	pb.RegisterSearchServer(srv, &searchServer{idx: idx})

	fmt.Printf("algolens_server listening on %s\n", *addr)
	if err := srv.Serve(lis); err != nil {
		log.Fatalf("serve: %v", err)
	}
}
