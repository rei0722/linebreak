# Single service: serves the built client and the WebSocket endpoint on one port.
# Keep BUN_VERSION in step with the Bun that wrote bun.lock (`bun --version`).
ARG BUN_VERSION=1.4.3
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
ARG VITE_SERVER_URL=
ARG VITE_PUBLIC_URL=
RUN bun run build

FROM oven/bun:${BUN_VERSION}
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY server ./server
COPY shared ./shared
COPY --from=build /app/client/dist ./client/dist
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "server/index.ts"]
