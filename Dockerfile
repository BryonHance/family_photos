# One image runs the viewer: the Hono server serves the analyze API and the
# built UI from the same origin. ExifTool (via exiftool-vendored) needs Perl.
# The face models are downloaded and checked here at build time; their licence
# is non-commercial research only, so this image is built on the personal
# server and never pushed to a registry (see the README).
ARG NODE_VERSION=26.12

FROM node:${NODE_VERSION}-slim AS base
RUN npm install --global pnpm@12.4.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN pnpm run build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM node:${NODE_VERSION}-slim AS models
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*
COPY scripts/fetch-models.sh /tmp/fetch-models.sh
COPY src/server/faces/models.sha256 /tmp/models.sha256
RUN MODEL_CHECKSUMS=/tmp/models.sha256 bash /tmp/fetch-models.sh /models

FROM node:${NODE_VERSION}-slim
RUN apt-get update \
  && apt-get install --yes --no-install-recommends perl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=3000 UI_DIR=/app/dist/web MODELS_DIR=/app/models
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=models /models ./models
COPY package.json ./
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY --from=build /app/dist/web ./dist/web
USER node
EXPOSE 3000
# Node runs the TypeScript server directly by stripping types. It refuses to
# start if a model file is missing or does not match its pinned SHA-256.
CMD ["node", "src/server/main.ts"]
