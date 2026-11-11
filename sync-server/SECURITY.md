# Security checklist

This server is a single-user, shared-secret snapshot store. It is not a multi-tenant collaboration service. Treat the data directory and `SYNC_TOKEN` as sensitive.

## Required before public exposure

1. **Terminate TLS in front of the server.** The server speaks plain HTTP. Do not port-forward it directly to the internet. The desktop app also accepts public `http://` endpoints, but that exposes the bearer token and archives in transit; use plain HTTP only behind a firewall/VPN or an encrypted tunnel.
2. **Use a long random token.** The server rejects tokens shorter than 24 bytes. Generate one with `openssl rand -hex 32`; never put it in a URL, shell history, screenshot, or issue.
3. **Bind to localhost or a firewall-limited interface.** `SYNC_HOST=127.0.0.1` is the default. The bundled Compose file publishes `127.0.0.1:8787` only. Expose the reverse proxy, not the Node port.
4. **Protect `SYNC_DATA_DIR`.** It contains plaintext `.ainovel` archives with manuscript text, project configuration, and portable assets. Use a private volume and back it up separately.
5. **Keep the runtime patched.** Use a current Node 22 image and rebuild the container after security updates.
6. **Use the hardened Compose defaults.** The provided service runs read-only with a tmpfs `/tmp`, drops all capabilities, sets `no-new-privileges`, limits PIDs/memory, and publishes only `127.0.0.1:8787`.

## Authentication and authorization

Internet scanners will still connect and receive `401`/`429`; authentication prevents access, not discovery. Reduce noise with a firewall/VPN/Tailscale or a reverse-proxy IP allowlist. Do not expose the Node port directly.

- Every route, including `/health`, requires `Authorization: Bearer <SYNC_TOKEN>`.
- There is one shared secret. Anyone with the token can read, upload, download, acquire leases, and overwrite any project ID on this server.
- There is no per-user identity, per-project ACL, token expiry, or audit log. Rotate the token by restarting the server with a new value; update every client immediately.
- The token is compared in constant time. Authentication failures return a stable `AUTH_REQUIRED` code and do not echo the supplied value.

## Abuse and resource limits

- Pre-auth probes are rate-limited per client IP. Authenticated requests use a separate token-keyed bucket at five times the limit, so an unauthenticated flood cannot lock out the owner. Set `SYNC_RATE_LIMIT=0` only when a trusted upstream already enforces limits.
- `SYNC_TRUST_PROXY=1` makes the limiter read the last `X-Forwarded-For` value. Enable it only behind a proxy that overwrites that header; otherwise clients can spoof their address.
- Uploads are streamed to a temporary file, capped at 512 MiB (`SYNC_MAX_BODY_BYTES`). Only one upload per project can be in flight; concurrent attempts get `409 UPLOAD_IN_PROGRESS`. Across projects, the default cap is four concurrent uploads (`SYNC_MAX_UPLOADS`).
- Each project has a hard cap of 500 snapshots by default (`SYNC_MAX_SNAPSHOTS`); further uploads fail until old snapshot files are removed. Set `SYNC_RETAIN_SNAPSHOTS` to a positive number to automatically keep only the latest N snapshots; the HEAD is never pruned and `0` disables pruning. The server creates at most 1000 project directories by default (`SYNC_MAX_PROJECTS`).
- Request headers time out after 30 seconds; a request has a 10-minute total timeout.
- The desktop client caps downloads at 512 MiB and verifies both the response hash and the hash listed in the project status.

## Integrity and state

- Snapshots are immutable once accepted. Each upload must match the caller's SHA-256 and the current `baseVersion`. A forced upload (`x-sync-force: 1`) still requires the live write lease and authentication, plus the HEAD version the author saw, so a branch that changed after the choice is not silently overwritten. It records both parent versions and the uploading hostname so the chosen branch is auditable.
- The writer lease prevents two writers from advancing the same project at once. Lease expiry allows takeover after the configured TTL (default 900 seconds).
- Downloads are hash-checked by the desktop client before restore. The client restores into a new project copy.
- The server does not inspect archive contents. The app's portable archive/restore service is the validator; keep it patched.

## Known limitations

- Archives are not end-to-end encrypted. The server operator and anyone with data-directory access can read them.
- There is no automatic merge. Two divergent copies remain divergent until a human chooses one snapshot or merges prose manually.
- A leaked token is equivalent to full control of this server's projects. Rotate it and review snapshots.
- No antivirus or content scanning is performed. Do not upload untrusted third-party archives.

## Incident response

1. Stop the server or remove it from the network.
2. Rotate `SYNC_TOKEN` and update all clients.
3. Preserve `SYNC_DATA_DIR` for investigation; do not let clients overwrite it.
4. Inspect `projects/*/head.json` and snapshot timestamps for unexpected uploads.
5. Restore the last known-good snapshot into a new project copy and verify before continuing.
