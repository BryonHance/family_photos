---
status: accepted
---

# Face embeddings are retained on the personal server so a Person can be recognised across Photos

Recognising a Person in many Photos means remembering their Faces between requests, which ADR-0001's "never retained" forbids. We make one narrow exception: for each Face found in a Photo, the server keeps the Face's embedding (a vector of numbers computed from it), the Face's box within the Photo, and a SHA-256 hash of the Photo's file, along with the name of each Person the user identifies. The Photo itself, and any crop or thumbnail of a Face, is still deleted once the response is sent. An embedding is not a picture, but it is biometric data about our children and a rough likeness of the face can be reconstructed from it, so it gets the same protection as the Photos: it never leaves the personal server, and the user can delete it.

## Considered Options

- **Detect faces only within the Photo being viewed**: fits ADR-0001 unchanged ("3 faces", boxes drawn on the Photo), but the viewer could never say who is in a Photo. Rejected because naming each Person across the collection is the point of the feature.
- **Also keep face crops, as Immich does**: would let the user browse and name groups of Faces without reopening Photos, but keeps pixels of children's faces long after the Photo is gone. Rejected: a Face is named while its Photo is open.
- **Keep embeddings in the browser only**: nothing would be retained on the server, but recognition would be lost whenever site data is cleared and could not be shared between the family's devices. Rejected.

## Consequences

- Face data is kept in one store on the personal server, separate from everything else, so it can be wiped in one step. Deleting a Person deletes their Faces' embeddings, and the user can delete all face data at once.
- Face data is kept out of any backup that leaves the server. Losing the server means re-opening Photos to recognise each Person again.
- The Photo hash lets the viewer recognise a Photo it has seen before without keeping it; it reveals nothing about the Photo's contents to anyone without the file.
- With no login (ADR-0001), anyone on the home network or VPN can see and change which Person is named in a Photo. Adding authentication first is still required before any public exposure.
- The face models run on the server, with their files built into the image and pinned by checksum; nothing is downloaded at runtime. If the chosen weights are licensed for non-commercial research only (InsightFace's are; see `docs/research/face-recognition-on-cpu.md`), they must not ship in a published image.
- Embeddings from different models cannot be compared, so changing the face model means recomputing every embedding, which needs every Photo to be opened again.
