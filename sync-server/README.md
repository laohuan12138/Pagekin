# Self-hosted snapshot sync

This directory contains the standalone server for Pagekin's single-writer sync mode. It stores sealed `.ainovel` archives and enforces:

- bearer-token authentication;
- one writer lease per project;
- optimistic `baseVersion` checks;
- immutable snapshot versions with SHA-256 integrity;
- project IDs limited to `[A-Za-z0-9._-]`.

It does **not** understand SQLite, LanceDB, or the desktop project. Never point it at a live project directory or ask it to merge databases. The desktop app exports a portable archive, uploads it, and restores downloads as a new project copy.

## Run

```bash
# from the repository root
SYNC_TOKEN="$(openssl rand -hex 32)" \
SYNC_DATA_DIR="./sync-data" \
SYNC_PORT=8787 \
pnpm sync:server
```

Or directly with Node 22:

```bash
SYNC_TOKEN="<long-random-token>" node sync-server/server.mjs
```

Quick check (health also requires the token):

```bash
curl -fsS -H "Authorization: Bearer $SYNC_TOKEN" http://127.0.0.1:8787/health
```

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `SYNC_TOKEN` | required | Shared sync code; every route sends it as a bearer token. At least 24 bytes |
| `SYNC_DATA_DIR` | `./sync-data` | Snapshot and lease storage |
| `SYNC_PORT` | `8787` | Listen port |
| `SYNC_HOST` | `127.0.0.1` | Listen host; use `0.0.0.0` in a container |
| `SYNC_RATE_LIMIT` | `120` | Pre-auth requests per client IP per window; authenticated traffic uses a separate token-keyed bucket at 5×. `0` disables |
| `SYNC_RATE_WINDOW_MS` | `60000` | Rate-limit window in milliseconds |
| `SYNC_TRUST_PROXY` | `0` | Set to `1` only when a reverse proxy overwrites `X-Forwarded-For` |
| `SYNC_MAX_UPLOADS` | `4` | Maximum concurrent upload bodies across projects |
| `SYNC_MAX_BODY_BYTES` | `536870912` | Maximum upload archive size (512 MiB) |
| `SYNC_MAX_SNAPSHOTS` | `500` | Hard cap per project; uploads fail at the cap |
| `SYNC_RETAIN_SNAPSHOTS` | `0` | When greater than 0, automatically keep only the latest N snapshots per project. Old snapshot files are deleted after a successful upload; the HEAD is never pruned. Must be less than `SYNC_MAX_SNAPSHOTS`. `0` disables automatic pruning. |
| `SYNC_MAX_PROJECTS` | `1000` | Maximum project directories the server will create |

The desktop app accepts both `http://` and `https://` origins. Plain HTTP sends the bearer token and archive contents unencrypted; use HTTPS, a VPN, or a firewall-restricted endpoint for any public deployment. The configured endpoint must be the origin (no subpath); mount a reverse proxy on its own hostname if needed.

In the app, open **Settings → Project backup → Self-hosted sync**, save the endpoint and token, bind the remote project ID, then acquire the write lease before uploading. Downloads always create a new project copy. With an empty bookshelf, **Project backup → Self-hosted sync recovery** can connect with the endpoint, token, and remote project ID, then restore a snapshot as a new project.

## Docker

```bash
cd sync-server
SYNC_TOKEN="$(openssl rand -hex 32)" docker compose up -d --build
```

`SYNC_TOKEN` is visible through `docker inspect` when passed as an environment variable. For long-lived deployments, use a `0600` `.env` file or a Docker secret and rotate the token after any suspected exposure.

The compose file publishes the port on `127.0.0.1` by default. Put a TLS reverse proxy in front of it before exposing it beyond the host or a trusted LAN.

## Protocol

All project routes require `Authorization: Bearer <SYNC_TOKEN>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness; same bearer token |
| `GET` | `/v1/projects/:id/status` | Head version, active lease, snapshot list |
| `POST` | `/v1/projects/:id/lease` | Acquire or renew a write lease |
| `POST` | `/v1/projects/:id/lease/release` | Release a write lease |
| `GET` | `/v1/projects/:id/snapshots` | Snapshot metadata |
| `POST` | `/v1/projects/:id/snapshots?baseVersion=N` | Upload a sealed archive |
| `GET` | `/v1/projects/:id/snapshots/:version` | Download an archive |

Lease body:

```json
{ "owner": "machine-name", "ttlSeconds": 900, "leaseId": "only for renewal" }
```

`ttlSeconds` defaults to 900 and is capped at 3600.

Upload headers:

```text
x-sync-lease-id: <lease>
x-sync-sha256: <64 lowercase hex characters>
x-sync-origin-project-id: <desktop project id>
x-sync-device-name: <hostname shown to the author>
x-sync-force: 1            # only after the author explicitly chooses this computer
x-sync-expected-head: <HEAD version the author saw>  # required with x-sync-force
```

A normal upload requires `baseVersion` to equal the current HEAD and records `parentVersions: [baseVersion]`. A forced upload may use an older `baseVersion`, but must also send the HEAD version the author saw; if HEAD changed again, the forced upload gets `409 VERSION_CONFLICT`. It records both the local base and the replaced remote HEAD in `parentVersions` and sets `forced: true`. The force flag never bypasses the write lease or authentication.

Responses use `{ "error": "CODE" }` for failures. A stale `baseVersion` returns `409 VERSION_CONFLICT`; an active lease owned by another writer returns `423 LEASE_HELD`. Upload renews the lease before the body is read, so a slow archive transfer cannot outlive the lease it started with. `status` and snapshot metadata include `deviceName`, `parentVersions`, and `forced`, which the desktop app uses to show which computers diverged and which branch won.

## Storage

```text
SYNC_DATA_DIR/
  projects/<sha256(projectId)>/head.json
  projects/<sha256(projectId)>/snapshots/v00000001.ainovel
```

`head.json` is written atomically after the archive is durable. Archive files are immutable. Back up the whole data directory; there is no server-side mutation or merge of project databases.

## Security and limits

See [SECURITY.md](SECURITY.md) for the deployment checklist and incident response.

- The token is a shared secret. Run the server behind TLS, keep the data directory private, and rotate the token if it leaks.
- Uploads are capped at 512 MiB by the server; the desktop client also reads the whole archive into memory for hashing and transfer.
- Snapshot archives contain manuscript text, project configuration, and portable assets. They are not end-to-end encrypted.
- The server is not a real-time collaboration service. Concurrent edits are rejected or require a manual copy/restore decision; there is no automatic merge.
