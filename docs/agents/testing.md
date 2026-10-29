# Testing

These are the repo's **agreed seams**: a test at one of them needs no fresh confirmation (the `tdd` skill's "pre-agreed seams"). A test anywhere else is a new seam; confirm it with the user first.

## Seams

**The API harness** (`src/server/testing/api.ts`, `openApi`). Posts Photos to `/api/analyze` and calls the naming routes, through `createApp` as in production, against a fresh `faces.db`. Catches anything the API returns or stores across a sequence of uploads: boxes, names, Suggestions, Stranger and Unknown pet labels, what deletion leaves behind. The default seam for server behaviour. Prior art: `naming.test.ts`, `suggestions.test.ts`, `pet-naming.test.ts`, `pet-suggestions.test.ts`.

**The rendered app** (`src/web/App.test.tsx`). Renders `<App />` in jsdom with `fetch` stubbed to return an `Analysis`. Catches what the user sees and clicks: boxes, labels, forms, the "People and pets" panel, error messages. Misses real layout and styling; nothing here runs a browser.

**The detector, for embeddings only** (`faces.test.ts`, `pets.test.ts`). Calls a detector's `detect` directly to check that the same Person or pet embeds close together and different ones far apart. Use it for embedding similarity, never for boxes or naming, which go through the API harness.

## Models

- Tests run the real models, so a mistake in channel order, normalisation or box decoding fails a test. `pixi run models` fetches them; `src/server/testing/global-setup.ts` checks them once per run.
- Load them through `src/server/testing/models.ts`, never `loadFaceDetector`/`loadAnimalDetector` directly: those hash every model and take one thread per core.
- **Synthetic embeddings** stand in for the real ones where real fixtures can't produce the case: a clash in one Photo, a chain of lookalikes, a match across species. Keep the real detector for the boxes and replace only the embeddings, as `facesWith` in `suggestions.test.ts` does.

## Fixtures

Fixtures are public domain or generated, never family Photos and never CC-attribution images (such as COCO's). Each is added through `scripts/make-fixtures.sh` with its source, licence and pinned SHA-256.
