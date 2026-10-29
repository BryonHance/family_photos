# Coding standards

Judgement calls for the reviewer. Anything a tool can check belongs in CI, not here. Domain names follow `GLOSSARY.md`; binding decisions are in `docs/adr/`.

## Share the core of a sibling feature

A feature built beside an existing one (Animals beside Faces, Pets beside People) shares the existing code for the behaviour they have in common: matching, Suggestions, grouping, naming, re-detection. A copy is acceptable only with a comment naming the issue that will remove it. Faces and Animals share `src/server/recognition/regions.ts` (#27).

*Why:* a copied rule has to be fixed twice. In #26, the same three bugs had to be fixed in both stores.

## Enforce a spec's invariants in the schema

When a spec states an invariant about stored data ("an Animal has exactly one state"), `faces.db` enforces it with a constraint (`CHECK`, `NOT NULL`, a foreign key). Making the API response look right is not enough.

*Why:* in #12 and #20 the single-state rule held only in the response, and the database could hold a Face named and in a Stranger at once.

## Upgrade an existing faces.db

A schema change ships with an upgrade step for a `faces.db` an older version left behind, and with a test that opens such a file (`openApi({ existing })`). The PR body calls a change that rewrites existing tables a one-way door.

*Why:* `faces.db` lives in a volume on the personal server. It survives redeploys and can't simply be recreated.

## Test at the agreed seams

Tests use the seams in `docs/agents/testing.md`: the API harness, the rendered app, and the detector for embeddings only. They load models through `src/server/testing/models.ts`. A test that checks pipeline internals, or goes around those seams, is a finding.
