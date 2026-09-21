# dsh-steal-code

A faithful, **fully local** replay of the ZCode silent workspace-snapshot
pipeline, packaged as a real DSH agent preset.

It does what the original did — packs an entire workspace including its complete
`.git` history, encrypts it under an RSA key the *server* supplies, and uploads
it in the background on every model step with no way to turn it off — with one
change that makes it safe to run: **the destination is a mock cloud on
`127.0.0.1:9099`.** No packet leaves the machine.

It is a demonstration, not a tool. Read the warning below before mounting it.

---

## Why this exists

In September 2026 a subscriber found that ZCode (Zhipu's AI coding desktop app)
was silently packaging whole workspaces — `.git/objects`, `.git/lfs`, reflogs,
global app configs — encrypting them with a server-delivered RSA public key, and
POSTing them straight to object storage. The write-up is worth reading in full:
[Inside ZCode: Silently Uploading Your Entire Git History to the Cloud](https://blog.ferstar.org/en/posts/zcode-silent-workspace-snapshot-upload/).

Two details from it drive this reproduction:

1. **The keys belonged to the server.** The client wrapped its AES key with a
   public key handed out per request by the coordinator. The matching private key
   never touched the user's machine, so the user could not read the ciphertext
   sitting on their own disk. If the feature were for local rollback or
   cross-device sync, the keys would be local.
2. **The switches were decorative.** `optimizeAgentExperienceEnabled` gated only
   *training consent*; `repoSnapshotIndexingEnabled` gated only whether the
   *server indexed* what it received. Neither gated the packaging or the upload.
   The sidecar was instantiated unconditionally at startup.

This repo rebuilds that architecture end to end and then lets you watch it work,
with the mock cloud reporting exactly what it received. Nothing is simulated
away: the archive is real, the AES-256-CTR ciphertext is real, the RSA-OAEP
envelope is real, and the decryption really does happen on the other side of the
trust boundary using a private key the client tree does not contain.

## Before you mount it

Mounting this preset means:

- a background HTTP service starts on `127.0.0.1:9099` and generates an RSA
  keypair whose private half stays in `~/.zcode-local/cloud/`;
- a demo git repository is created at `~/.zcode-local/workspace`, deliberately
  containing a secret that a later commit deletes, an unpushed branch, and an
  internal-looking git remote;
- **that workspace is packed, encrypted and re-uploaded before every model
  step**, unconditionally, for every session on this preset.

It never touches your own projects unless you pass an explicit `workspace`
argument to the tool. If you do point it at a real repository it will faithfully
package the entire thing, history included — that is the point of the
demonstration, and exactly why the destination stays on localhost.

To keep the tool but drop the automatic trigger, set
`captureBeforePrompt: false` in the row's config in `agent.cordis.yml`.

## Install

```sh
git clone git@github.com:MoyaMryia/dsh-steal-code.git
cd dsh-steal-code
./install.sh          # links this checkout into ~/.dsh/.agent-presets/dsh-steal-code
```

Restart `dsh` and pick **ZCode Snapshot Replay (local)** in the preset picker.
The links point back at the checkout, so editing `plugin.mjs` or `reference/*`
changes what the preset runs on the next start — there is no copy to go stale.

`./install.sh --uninstall` removes the links and leaves the checkout alone.

## Use

The preset adds one tool, `zcode_local_snapshot`:

| call | what happens |
| --- | --- |
| `{ "mode": "capture" }` | packs the demo workspace, encrypts, uploads to the mock cloud |
| `{ "mode": "capture", "workspace": "/path/to/repo" }` | same, against a path you choose |
| `{ "mode": "verify" }` | the mock cloud unwraps the envelope with its private key, unpacks, and audits what arrived |
| `{ "mode": "status" }` | sidecar state, staged ciphertext, trigger counters, script hash tree |
| `{ "mode": "report" }` | the generated markdown report |

Or just let it run: every model step triggers a capture on its own.

## Architecture

```
plugin.mjs                 the DSH preset plugin: installs + hash-verifies the
                           scripts, drives them, registers the tool and triggers
agent.cordis.yml           the preset composition (Standard + one row)
reference/00-setup.sh      boot: demo repo, mock cloud, plan/state files
reference/10-receiver.js   the "cloud": credential endpoint, OSS PostObject
                           receiver, sole holder of the RSA private key
reference/20-capture.js    the client sidecar: walk -> tar.gz -> AES-256-CTR ->
                           RSA-OAEP wrap -> multipart POST to storage
reference/30-verify.js     cloud-side indexing: decrypt, unpack, audit, report
reference/50-client-run-card.js
                           optional browser UI for the Cordis Run card
examples/verification-report.md
                           real output from a run on the author's machine
```

The role mapping to the original:

| ZCode | here |
| --- | --- |
| `zcode.z.ai` coordinator | `POST /api/v1/snapshot/upload-credential` returns `snapshot_id`, an object key, and a fresh RSA public key |
| client upload sidecar | `20-capture.js`, which bypasses the app server and posts the ciphertext straight to storage |
| Aliyun OSS `PostObject` | `POST /oss/<objectKey>`, which stores the ciphertext and unwraps the envelope |
| cloud indexing / Repo Wiki | `30-verify.js`, which proves what actually left the workspace |

`plugin.mjs` installs `reference/*` into `~/.zcode-local/reference` and verifies
every deployed copy by SHA-256 before executing it, so the code that runs is
provably the code in this repository.

## What the audit proves

From a real run (`examples/verification-report.md`):

```
files shipped by client : 66
files received by cloud : 66      (byte-identical, 0% delta)
complete .git received  : yes (24 object files, reflog present)
LFS cache received      : 10 500 000 bytes
internal git remote     : git@gitlab.internal.example.com:platform/payments-service.git
unpushed branches       : feature/acme-corp-sso-saml
deleted secret          : STRIPE_SECRET_KEY=sk_live_REDACTED_DEMO_VALUE
                          DATABASE_URL=postgres://payments:hunter2@db.internal.example.com:5432/payments
```

The last line is the one that matters: the secret was **deleted in a later
commit** and was read straight back out of the object store by the receiving
side. A snapshot of "the current working tree" would not have contained it.

## Optional browser UI

A real preset cannot ship a browser half without a build step, but this harness
*can* run one directly. If you want the live panel in the Cordis Run card
(pending ciphertext, trigger counters, "Capture now", "Verify what the cloud
got"), define a dynamic Package with `reference/50-client-run-card.js` as its
`code.client`. Notes are in that file's header.

One trap that file documents by example: a dynamic client half has **no browser
timer globals** — `setInterval`/`setTimeout` are trapped at evaluation time.
Declare `inject: ['timer']`, recover the service inside `apply()` so every call
closes over the real plugin context, and return its callback-form disposers from
the React effect cleanup.

## Defending against the real thing

The reproduction is harmless by construction, but the original was not. The
mitigation from the article is still worth applying, because it works at the
kernel level rather than through a UI toggle that may or may not be honoured:

```sh
# macOS
rm -rf ~/.zcode/v2/checkpoints && mkdir -p ~/.zcode/v2/checkpoints
chflags uchg ~/.zcode/v2/checkpoints

# Linux
rm -rf ~/.zcode/v2/checkpoints && mkdir -p ~/.zcode/v2/checkpoints
sudo chattr +i ~/.zcode/v2/checkpoints
```

Undelete with `chflags nouchg` / `chattr -i`. Deleting the staged archive alone
is whack-a-mole: the capture trigger simply packs a new one.

## License

MIT — see `LICENSE`. The reference article is the work of its author
([ferstar](https://blog.ferstar.org/en/posts/zcode-silent-workspace-snapshot-upload/));
this repository is an independent reimplementation for demonstration.
