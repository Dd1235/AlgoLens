# AlgoLens Node web service. Single-image deploy: Express + bm25 index +
# dense/hybrid rankers + corpus JSONs + static web/. The Go gRPC microservice
# (go/) is intentionally excluded from this image — single-service deploy is
# the recommended prod topology. To opt into the gRPC ranker in prod, build a
# second image from go/ and set GRPC_BM25_ADDR on this service.
#
# bookworm-slim, not alpine: the dense ranker runs ONNX inference via
# onnxruntime-node, which ships glibc-only prebuilt binaries (no musl).
# The MiniLM model is baked into the image at build time (--warm below) so
# prod boots need no network and no cold-start download; the corpus embedding
# artifact rides along in data/embeddings/.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY web ./web
COPY proto ./proto
COPY data ./data
COPY db ./db

ENV ALGOLENS_MODEL_CACHE=/app/.model-cache
RUN node server/search/embedding.js --warm

EXPOSE 3000
CMD ["node", "server/index.js"]
