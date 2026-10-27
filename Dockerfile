# One image runs the viewer: the Hono server serves the analyze API and the
# built UI from the same origin. ExifTool (via exiftool-vendored) needs Perl.
# The face and pet models are downloaded and checked here at build time, and the
# Avito CLIP-L is exported to ONNX. The face models' licence is non-commercial
# research only, so this image is built on the personal server and never pushed
# to a registry (see the README).
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

# AvitoTech's CLIP-L has no ONNX release, so its vision tower is exported here,
# with Python and PyTorch pinned by pixi.lock. The export fails the build unless
# ONNX matches PyTorch within 1e-3. Only the ONNX model and its recorded SHA-256
# leave this stage, so PyTorch never reaches the final image.
FROM ghcr.io/prefix-dev/pixi:0.83.0 AS avito
WORKDIR /export
COPY pixi.toml pixi.lock ./
RUN pixi install --locked --environment pet-export
COPY scripts/export-avito.py ./scripts/
RUN pixi run --locked --environment pet-export python scripts/export-avito.py /avito

FROM node:${NODE_VERSION}-slim AS models
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*
COPY scripts/fetch-models.sh /tmp/fetch-models.sh
COPY src/server/faces/models.sha256 /tmp/models.sha256
RUN MODEL_CHECKSUMS=/tmp/models.sha256 bash /tmp/fetch-models.sh /models
# The pet models, versioned apart from the face models, in their own directory.
COPY scripts/fetch-pet-models.sh /tmp/fetch-pet-models.sh
COPY src/server/pets/models.sha256 /tmp/pet-models.sha256
RUN PET_MODEL_CHECKSUMS=/tmp/pet-models.sha256 bash /tmp/fetch-pet-models.sh /models/pets
COPY --from=avito /avito/avito_clip_l.onnx /avito/avito_clip_l.onnx.sha256 /models/pets/

FROM node:${NODE_VERSION}-slim
RUN apt-get update \
  && apt-get install --yes --no-install-recommends perl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=3000 UI_DIR=/app/dist/web MODELS_DIR=/app/models FACES_DB=/app/data/faces.db
# faces.db lives in the named volume docker-compose.yml mounts here. The
# directory is created owned by node so that a new, empty volume is writable.
RUN mkdir /app/data && chown node:node /app/data
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
