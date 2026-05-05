# Experiment 02 — C++/gRPC microservice attempt (abandoned)

**Date:** 2026-05-05
**Outcome:** Reverted. Replacing with a Go microservice (see follow-up experiment).

## What was tried

Build a C++ BM25 scoring microservice exposing the existing `proto/algolens.proto` contract over gRPC, drop-in behind the Node `SearchIndex` boundary. Source lived in `cpp/` (CMake + handwritten BM25 + tokenizer + gRPC server using nlohmann/json for corpus loading).

The code itself worked: it compiled cleanly against the local toolchain and produced an `algolens_server` binary.

## What broke

`dyld[..]: Symbol not found: __ZN4absl12lts_2025012712log_internal10LogMessage...`

The conda environment had a cross-channel ABI mismatch:

- `libabseil 20250127.0` from the `pkgs/main` (Anaconda) channel
- `libre2-11 2024.07.02 ..._3` from `conda-forge`
- `libgrpc 1.71.0` from `pkgs/main`

`libre2` (and transitively `libgrpc`) were built against a *different* abseil LTS tag than the installed `libabseil`. At dlopen time the absl symbols don't resolve, the binary refuses to start.

## Fix attempts

1. `conda install --override-channels -c conda-forge ...` — dry-run claimed nothing needed updating; resolver wasn't strict enough about ABI.
2. `conda install --force-reinstall ...` into the base env — refused, because conda's own dependencies (`requests`) would have to be removed.
3. New dedicated env `algolens-cpp` from conda-forge — succeeded but cost ~554 MB of disk for what's effectively a single-binary build dependency.

(3) would have worked. Removed instead.

## Why we didn't continue

Two reasons:

1. **Toolchain pollution.** The conda env we were drawing from has accumulated Python/ML packages from years of unrelated work, with mixed channel histories. Trying to bend it to a clean C++ build was the wrong battle. A fresh Homebrew stack (`brew install grpc nlohmann-json`) would have been clean.
2. **Better answer exists.** Switching the microservice to **Go** instead of C++ is a strictly better fit for this project's framing:
   - The resume bullet wants to read "polyglot backend" — Go-as-a-service is the modern norm; C++/gRPC is more of a niche systems-engineering signal.
   - Go's gRPC story is one-install (`go mod tidy`) with no header/library/ABI fight.
   - At 1185 docs even Node BM25 is sub-millisecond; the latency story doesn't hinge on C++ specifically. The polyglot architecture is the point.
   - Go's concurrency model gives a more interesting "what about under load?" benchmark question than C++ would have.

## What survived the rollback

- `proto/algolens.proto` — language-agnostic, reused as-is by the Go service.
- `server/search/grpc_index.js` — Node client. The only thing it cares about is the proto contract.
- `server/index.js` — opt-in `bm25-grpc` registration via env var. Renamed from `bm25-cpp` in the follow-up.

## Lesson

When a side-quest toolchain has known-bad cross-channel state, take 10 minutes to install a clean stack from one source instead of an hour bending the broken one.

Disk reclaimed by removing the conda env and `cpp/` tree: ~557 MB.
