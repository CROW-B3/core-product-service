# Build stage
FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . ./

RUN bun build src/index.ts --compile --outfile server

FROM debian:bookworm-slim

WORKDIR /app

COPY --from=builder /app/server ./server

CMD ["./server"]
