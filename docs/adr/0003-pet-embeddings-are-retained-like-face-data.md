---
status: accepted
---

# Pet embeddings are retained on the personal server, with the same protection as face data

Recognising a Pet in many Photos means remembering their Animals between requests, which ADR-0001's "never retained" forbids and ADR-0002's exception, scoped to Faces, does not cover. We make a second narrow exception: for each Animal found in a Photo, the server keeps the Animal's embedding and its box within the Photo, alongside the Photo's SHA-256 hash, plus the name of each Pet the user identifies. The Photo and any crop of an Animal are still deleted once the response is sent. A pet's embedding is not biometric data about a person, but an Animal's box often takes in the child hugging the dog, so the embedding is partly computed from a child's face. Pet data therefore gets the same protection as face data: it never leaves the personal server, and the user can delete it.

## Considered Options

- **Widen ADR-0002 to "face and pet data"**: one rule instead of two, but it rewrites an accepted decision whose reasoning rests on children's biometrics, which pets are not. Rejected so that ADR-0002's argument stays undiluted.
- **Lighter protection for pet data** (allowed in backups that leave the server): reasonable for pixels of animals alone, but Animal boxes routinely include children, so their embeddings would leave the server. Rejected.

## Consequences

- Pet data lives in the same store as face data and is wiped by the same one-step delete. It is kept out of any backup that leaves the server, as face data is.
- Deleting a Pet removes the name but keeps their Animals' embeddings, which become Unknown pets again, matching how deleting a Person works under ADR-0002.
- The pet models are separate from the face models and are pinned the same way: built into the image, checked by checksum, never downloaded at runtime. Changing a pet model means recomputing every Animal's embedding, independently of the face model. The weights chosen in `docs/research/face-and-pet-recognition.md` (D-FINE-S, Avito CLIP-L) are Apache-2.0. If non-commercial weights (MegaDescriptor, PetFace) were chosen instead, they could not ship in a published image.
- ADR-0001 now has two retention exceptions, face data (ADR-0002) and pet data (this ADR).
