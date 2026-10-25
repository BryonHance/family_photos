# Family Photos

A private web viewer for the metadata inside family Photos. Drop a Photo in the browser; the server reads it with ExifTool, returns its Fields, and deletes it. Photos are never modified, never retained, and never sent anywhere beyond the personal server ([ADR-0001](docs/adr/0001-read-only-non-retaining-private.md)). The viewer finds the Faces in each Photo and lets you name them. To recognise a Person across Photos it keeps face data on the server, but never the Photo or any image of a Face ([ADR-0002](docs/adr/0002-face-embeddings-are-retained-on-the-server.md)).

## Development

Requires [pixi](https://pixi.sh).

```sh
pixi run models     # download the face models into models/ (needed by dev and test)
pixi run dev        # analyze API on :3000 and the Vite UI, with /api proxied
pixi run test
pixi run typecheck
```

The server refuses to start until `pixi run models` has fetched the face models and their SHA-256s match.

## Face models and their licence

The viewer finds Faces with InsightFace's [`buffalo_sc`](https://github.com/deepinsight/insightface/releases/tag/v0.7) models (the SCRFD-500MF detector and the MobileFaceNet recognizer), run on the CPU with ONNX Runtime. InsightFace releases these weights **for non-commercial research only**. This viewer is a private, non-commercial tool for one family, and relies on that licence. So that the weights are never redistributed:

- they are never committed to this public repository: `pixi run models` downloads them into the git-ignored `models/`;
- the Docker build downloads them and checks their pinned SHA-256s, and the image is built only on the personal server and never pushed to a registry.

Anyone forking this repository for another purpose must check the licence for themselves. See `docs/research/face-recognition-on-cpu.md` §6.

## Face data

Everything the viewer remembers about Faces is in one SQLite file, `faces.db`: each Face's embedding (512 numbers computed from it) and box, the SHA-256 of the Photo it was found in, the model version, its Person or Stranger number, the Suggestions rejected for it, and the name of each Person. It holds nothing else. Embeddings of children's faces are biometric data, and a rough likeness of a face can be reconstructed from one.

- In Docker, `faces.db` lives in the named volume `face-data`, mounted at `/app/data`. In development it is `data/faces.db`, which git ignores. Set `FACES_DB` to put it elsewhere.
- **Keep the `face-data` volume out of every backup that leaves the server**, such as cloud or off-site backups. If the server is lost, open the Photos again to name each Person again.
- "Delete all face data" in the People panel empties the file. Removing the volume (`docker compose down` then `docker volume rm family_photos_face-data`, or whatever name `docker volume ls` shows) also deletes it.

### Tuning Suggestions and Strangers

A Face is suggested as a Person when its embedding's cosine similarity to one of their named Faces is at least 0.5, and joins a Stranger at 0.6. Both are starting points, set in `src/server/faces/thresholds.ts`. To check them, put a small sample of your own Photos in a folder outside the repository, one subfolder per person, each Photo showing that person as its largest Face, then run:

```sh
pixi run similarity /path/to/sample
```

It prints how similar Faces of the same person and of different people are, and what share of each pair lies above each threshold. It stores nothing and prints only numbers. Never commit the sample.

## Deployment

The viewer runs on the personal server as one Docker container. The image includes Perl for ExifTool and the face models, and runs the Hono server, which serves both the analyze API and the built UI from the same origin. Because of the models' licence (above), build the image on the server and never push it to a registry.

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
