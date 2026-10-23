# Photos are analyzed read-only, never retained, and never leave the personal server

Family Photos carry GPS locations and children's faces, so the viewer promises three things: it never modifies a Photo, it deletes each uploaded Photo once the response is sent, and it sends nothing beyond the personal server it runs on. The server is reachable only from the home network and VPN, which is why v1 has no login.

## Considered Options

- **Browser-only, fully offline**: the strongest privacy, but browsers can't run ExifTool, so Maker notes and format coverage suffer. Rejected in favour of backend analysis on a machine we control.
- **Hosted service**: usable from anywhere, but uploads family Photos to a third party and needs authentication. Rejected.

## Consequences

- No geocoding of GPS coordinates through an external API, no embedded third-party maps, and no editing or stripping of metadata. Changing any of these means revisiting this ADR.
- Exposing the server to the public internet means adding authentication first.
