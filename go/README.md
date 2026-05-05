# algolens — Go BM25 microservice

Implements `proto/algolens.proto` `Search.SearchTopK` over gRPC. Functionally identical to [server/search/bm25.js](../server/search/bm25.js): same tokenizer, same params (`k1=1.5`, `b=0.75`), same RSJ IDF. The Node `SearchIndex` interface treats this and the in-memory rankers as interchangeable.

## Build

```sh
cd go
go build -o algolens_server .
```

Single static binary, no runtime deps.

## Run

```sh
./algolens_server --addr 0.0.0.0:50051 --corpus ../data/problemset_llm
```

Loads `{leetcode,cses}/*.json` under `--corpus`, builds BM25 once at startup, serves gRPC. Build time on the 1185-doc corpus: ~6 ms.

## Wire it into the Node app

```sh
GRPC_BM25_ADDR=127.0.0.1:50051 npm run dev
```

The Node server probes the address on boot; on success registers `bm25-grpc` alongside `tfidf` and `bm25`. Falls back gracefully if unreachable. Then:

```sh
curl 'http://localhost:3000/api/search?q=monotonic+stack&ranker=bm25-grpc&k=5'
```

## Bench it

```sh
GRPC_BM25_ADDR=127.0.0.1:50051 node bench/run.js
```

Adds a `bm25-grpc` row to the comparison table with both client-perceived latency and server-side scoring time. See [experiments/03-go-vs-node-bm25.md](../experiments/03-go-vs-node-bm25.md) for the current write-up.

## Regenerating the proto bindings

The generated files are committed at [proto/algolens.pb.go](proto/algolens.pb.go) and [proto/algolens_grpc.pb.go](proto/algolens_grpc.pb.go). To regenerate after editing [../proto/algolens.proto](../proto/algolens.proto):

```sh
PATH="$HOME/go/bin:$PATH" protoc \
  --go_out=go --go_opt=paths=source_relative \
  --go-grpc_out=go --go-grpc_opt=paths=source_relative \
  -I proto proto/algolens.proto
```

Then move `go/algolens*.pb.go` into `go/proto/` (paths=source_relative writes them at the package root by default).
