# AlgoLens Node web service. Single-image deploy: Express + bm25 index +
# corpus JSONs + static web/. The Go gRPC microservice (go/) is intentionally
# excluded from this image — single-service deploy is the recommended prod
# topology. To opt into the gRPC ranker in prod, build a second image from
# go/ and set GRPC_BM25_ADDR on this service.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS run
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

EXPOSE 3000
CMD ["node", "server/index.js"]
