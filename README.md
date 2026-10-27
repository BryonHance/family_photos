# Family Photos

A private web viewer for the metadata inside family Photos. Drop a Photo in the browser; the server reads it with ExifTool, returns its Fields, and deletes it. Photos are never modified, never retained, and never sent anywhere beyond the personal server ([ADR-0001](docs/adr/0001-read-only-non-retaining-private.md)). The viewer finds the Faces in each Photo and lets you name them. To recognise a Person across Photos it keeps face data on the server, but never the Photo or any image of a Face ([ADR-0002](docs/adr/0002-face-embeddings-are-retained-on-the-server.md)).

## Development

Requires [pixi](https://pixi.sh).

```sh
pixi run models     # download the face and pet models into models/ (needed by dev and test)
pixi run dev        # analyze API on :3000 and the Vite UI, with /api proxied
pixi run test
pixi run typecheck
```

The server refuses to start until `pixi run models` has fetched the face and pet models and their SHA-256s match.

## Face models and their licence

The viewer finds Faces with InsightFace's [`buffalo_sc`](https://github.com/deepinsight/insightface/releases/tag/v0.7) models (the SCRFD-500MF detector and the MobileFaceNet recognizer), run on the CPU with ONNX Runtime. InsightFace releases these weights **for non-commercial research only**. This viewer is a private, non-commercial tool for one family, and relies on that licence. So that the weights are never redistributed:

- they are never committed to this public repository: `pixi run models` downloads them into the git-ignored `models/`;
- the Docker build downloads them and checks their pinned SHA-256s, and the image is built only on the personal server and never pushed to a registry.

Anyone forking this repository for another purpose must check the licence for themselves. See `docs/research/face-recognition-on-cpu.md` §6.

## Pet models and their licence

The viewer finds cats and dogs with [D-FINE-S](https://github.com/Peterande/D-FINE) trained on COCO, in onnx-community's [ONNX conversion](https://huggingface.co/onnx-community/dfine_s_coco-ONNX) at a pinned revision, run on the CPU with ONNX Runtime. It is Apache-2.0, unlike the face models, but it is still never committed: `pixi run models` downloads it into the git-ignored `models/pets/`, and the Docker build downloads it and checks its pinned SHA-256. Only the COCO-trained checkpoint is used; the Objects365 ones may not be cleared for use under the same licence.

The viewer tells individual cats and dogs apart with AvitoTech's [CLIP-L for animal identification](https://huggingface.co/AvitoTech/Zer0int-CLIP-L-for-animal-identification), also Apache-2.0, at a pinned revision. It has no ONNX release, so `pixi run models` and the Docker build download its weights, check their pinned SHA-256 and export the vision tower to ONNX with PyTorch (in a separate pixi environment and build stage, so PyTorch never reaches the app or the image). The build fails unless the export matches PyTorch, and the exported model's SHA-256 is recorded beside it for the server to check.

The Avito model was trained partly on [PetFace](https://github.com/mapooon/PetFace), whose authors release it "for research purposes only". Whether those terms reach a model trained on it is unresolved. This private, non-commercial viewer is fine either way, but anyone publishing an image or using the model commercially must check for themselves. See `docs/research/face-and-pet-recognition.md` §6.

## Face and pet data

Everything the viewer remembers about Faces is in one SQLite file, `faces.db`: each Face's embedding (512 numbers computed from it) and box, the SHA-256 of the Photo it was found in, the model version, its Person or Stranger number, the Suggestions rejected for it, and the name of each Person. Embeddings of children's faces are biometric data, and a rough likeness of a face can be reconstructed from one.

The same file holds pet data, with the same protection (ADR-0003): each Animal's embedding (768 numbers) and box, its species, the Photo's SHA-256, the pet model version, its Pet, Unknown pet number or "Not a pet" mark, the Suggestions rejected for it, and the name of each Pet. An Animal's box often takes in the child hugging the dog, so its embedding is partly computed from a child's face. The file holds nothing else: never a Photo or any image of a Face or Animal.

- In Docker, `faces.db` lives in the named volume `face-data`, mounted at `/app/data`. In development it is `data/faces.db`, which git ignores. Set `FACES_DB` to put it elsewhere.
- **Keep the `face-data` volume out of every backup that leaves the server**, such as cloud or off-site backups. If the server is lost, open the Photos again to name each Person and Pet again.
- "Delete all face and pet data" in the People and pets panel empties the file. Removing the volume (`docker compose down` then `docker volume rm family_photos_face-data`, or whatever name `docker volume ls` shows) also deletes it.

### Tuning Suggestions and Strangers

A Face is suggested as a Person when its embedding's cosine similarity to one of their named Faces is at least 0.5, and joins a Stranger at 0.6. Both are starting points, set in `src/server/faces/thresholds.ts`. To check them, put a small sample of your own Photos in a folder outside the repository, one subfolder per person, each Photo showing that person as its largest Face, then run:

```sh
pixi run similarity /path/to/sample
```

It prints how similar Faces of the same person and of different people are, and what share of each pair lies above each threshold. It stores nothing and prints only numbers. Never commit the sample.

### Tuning pet Suggestions and Unknown pets

An Animal is suggested as a Pet when its embedding's cosine similarity to one of their named Animals is at least 0.65, and joins an Unknown pet at 0.70. Both come from a trial on 20 Photos of our five pets (`docs/research/face-and-pet-recognition.md` section 8) and are set in `src/server/pets/thresholds.ts`. To check them, put a sample of your own Photos in a folder outside the repository, one subfolder per pet, then run:

```sh
pixi run pet-trial /path/to/sample
```

It too stores nothing and prints only numbers. Never commit the sample.

## Deployment

The viewer runs on the personal server as one Docker container. The image includes Perl for ExifTool and the face and pet models, and runs the Hono server, which serves both the analyze API and the built UI from the same origin. Because of the face models' licence (above), build the image on the server and never push it to a registry.

> **Home network and VPN only.** v1 has no login. Never expose the viewer's port to the public internet; adding authentication must come first (ADR-0001).

### First install

```sh
git clone https://github.com/BryonHance/family_photos.git
cd family_photos
docker compose up -d --build
```

The viewer is then at `http://<server>:8080`. To use another port, change the host side of `ports` in `docker-compose.yml` (for example `"9000:3000"`).

### Updating

There is no container registry or auto-deploy. On the server:

```sh
git pull
docker compose up -d --build
```
