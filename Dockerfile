FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . ./
RUN bunx wrangler deploy --dry-run --outdir .wrangler/dist --env local

FROM jacoblincool/workerd
WORKDIR /worker
COPY --from=builder /app/.wrangler/dist/index.js ./index.js
COPY worker.capnp ./worker.capnp
EXPOSE 8080
