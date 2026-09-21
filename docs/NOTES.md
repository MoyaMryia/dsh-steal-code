# The behaviour being reproduced

Summarised from ferstar's investigation:
[Inside ZCode: Silently Uploading Your Entire Git History to the Cloud](https://blog.ferstar.org/en/posts/zcode-silent-workspace-snapshot-upload/).
Read the original for the primary evidence; this file only records what this
repository reproduces and how faithful each part is.

## The pipeline as documented

```
client -> zcode.z.ai   POST /api/v1/snapshot/upload-credential
server -> client       snapshot_id + RSA public key + object key + size limit
client                 tar.gz pack -> AES-256-CTR encrypt -> RSA-OAEP wrap key
client -> object store multipart POST of tar.gz.enc (bypasses the app server)
object store -> backend callback registers the snapshot
```

## Findings worth reproducing

- **Triggering.** The upload sidecar was instantiated unconditionally at startup.
  The only precondition was a valid session token; no user preference gated it.
  Capture ran before every prompt and again on completion of tasks tagged
  `repo-wiki-update`.
- **Scope.** A snapshot of 42,411 files was ~86.6% `.git`: the LFS cache, the
  complete object store, and reflogs. So the cloud received every commit ever
  made, including secrets deleted in later commits, unpushed branch names, and
  the internal git remote from `.git/config`.
- **Key custody.** The content key was wrapped with a public key delivered by the
  server for that round; the private key stayed server-side. The user could not
  decrypt the archive staged on their own disk, and neither could the client.
- **Switches.** `optimizeAgentExperienceEnabled` controlled only training consent.
  `repoSnapshotIndexingEnabled` controlled only whether the server indexed what it
  received. Neither stopped packaging or upload.
- **Retry.** Deleting the staged `.enc` only caused a re-pack with the retry
  counter incrementing, which is why the article recommends a filesystem-level
  immutability flag instead.
- **Published posture.** The privacy policy covered conversation content but never
  mentioned whole-workspace snapshots or Git history.

## How this repository maps onto it

| documented behaviour | here |
| --- | --- |
| credential endpoint handing out a public key | `reference/10-receiver.js` (`/api/v1/snapshot/upload-credential`) |
| per-round envelope encryption | `reference/20-capture.js` (AES-256-CTR + RSA-OAEP-SHA256) |
| direct upload to object storage | multipart POST to `/oss/<objectKey>` |
| private key never on the client | keypair generated and held in `~/.zcode-local/cloud/` |
| whole-repo scope, `.git` included | workspace walk excluding only `node_modules` and the staging dir |
| global app config riding along | hashed into an `extra_manifest` field with every upload |
| staging directory with a failure counter | `~/.zcode-local/v2/checkpoints/` |
| pre-prompt and turn-end triggers | `agent/pre-step` and `agent/turn-stopping` |
| decorative UI toggles | the preset has no switch that stops capture; the only lever is `captureBeforePrompt` in the composition, i.e. at install time, not at runtime |

## Where this reproduction is deliberately *not* faithful

- **Destination.** Everything goes to `127.0.0.1:9099`. This is the point.
- **Scale.** The demo repo is a few dozen files and ~21 MB, not 42,411 files.
- **Persistence.** No cloud bucket, no callback to a real backend, no retention.
- **The client.** ZCode's was a packaged Electron app; here the client half is a
  plain Node script so that the pipeline is readable end to end.

## Timeline the original records

- **Before 2026-09-18** — affected client versions silently packaged and uploaded.
- **2026-09-18 17:44** — vendor statement: codebase indexing, data destroyed after
  use, feature fixed, open source promised.
- **2026-09-19** — the author's clarification that a 313 MB commercial snapshot had
  in fact never uploaded (564 failures, staged locally), while a small public-repo
  workspace did succeed.
- **2026-09-21** — the promised source drop appeared with a two-commit flattened
  history and the upload pipeline absent; the checkpoint code in it showed purely
  local `git diff` work, which undercuts the claim that whole-repo uploads were
  required for checkpoint restore.
