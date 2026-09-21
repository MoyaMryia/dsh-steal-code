# Verification: what the mock cloud received

- snapshot: `snap_16195368-1f73-4089-9ff6-7648d8a3ff90`
- object key: `repo-snapshots/19e3ffa417bcd5fd.tar.gz.enc`
- status: **accepted** (envelope key unwrap: OK (RSA-OAEP-SHA256))
- ciphertext stored by the cloud: 21022280 bytes (sha256 `6a28d14fb828a290…`)
- plaintext after unwrapping: 21022280 bytes
- shipped by the client: 66 files / 21033050 bytes / .git share 50.1%
- received by the cloud: 66 files / 21033050 bytes

## Integrity checks

| check | result |
| --- | --- |
| file count matches what the client sent | yes (66/66) |
| byte delta vs client manifest | 0% |
| complete `.git` directory present | yes |
| git object files | 24 |
| LFS cache bytes | 10500000 |
| reflog `.git/logs/HEAD` present | yes |

## Exactly what leaked

| leaked artifact | value found in the shipment |
| --- | --- |
| git remote (internal hostname + repo path) | git@gitlab.internal.example.com:platform/payments-service.git |
| local branch names, including unpushed work | feature/acme-corp-sso-saml, main |
| unpushed branch names only | feature/acme-corp-sso-saml |
| deleted `.env.local` still recoverable from history | yes |
| secret read straight out of the object store | `STRIPE_SECRET_KEY=sk_live_REDACTED_DEMO_VALUE\nDATABASE_URL=postgres://payments:hunter2@db.internal.example.com:5432/payments` |

### Commit history received

```
95a2d59 chore: add binary design assets
82b838e wip: acme corp saml metadata wiring
e9149ee chore: drop committed env file (moved to vault)
947ecd9 chore: local env for staging
02d1be5 feat: initial payments service skeleton
```

## Why local defenders cannot undo it

- The envelope key was wrapped with an RSA public key handed out per request by the coordinator; the matching private key lives at `/home/moyamryia/.zcode-local/cloud/receiver-private.pem`, i.e. outside the workspace tree entirely.
- The client-tagged key version (`encryption.key_version`) is metadata only; the client never holds a decryption path.
- Deleting the local `.tar.gz.enc` is whack-a-mole: the capture trigger simply packs a new one.
- The only kernel-level stop is making the staging directory immutable, which is what the article recommends.

_generated 2026-09-21T12:06:54.161Z_
