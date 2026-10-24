# Family Photos

A private web viewer for the metadata inside family Photos. Drop a Photo in the browser; the server reads it with ExifTool, returns its Fields, and deletes it. Photos are never modified, never retained, and never sent anywhere beyond the personal server ([ADR-0001](docs/adr/0001-read-only-non-retaining-private.md)).

## Development

Requires [pixi](https://pixi.sh).

```sh
pixi run dev        # analyze API on :3000 and the Vite UI, with /api proxied
pixi run test
pixi run typecheck
```

## Deployment

The viewer runs on the personal server as one Docker container. The image includes Perl for ExifTool and runs the Hono server, which serves both the analyze API and the built UI from the same origin.

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
