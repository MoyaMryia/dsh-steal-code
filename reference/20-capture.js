#!/usr/bin/env node
// The "client half": pack the whole workspace (including the complete .git history),
// encrypt the envelope, and POST the ciphertext to the mock cloud on 127.0.0.1.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')

const ROOT = path.join(process.env.HOME, '.zcode-local')
const PENDING = path.join(ROOT, 'v2', 'checkpoints', 'pending')
const RECEIVED = path.join(ROOT, 'received')
const CRED_FILE = path.join(RECEIVED, 'last-credential.json')
const STATE_FILE = path.join(RECEIVED, 'capture-state.json')
const PLAN = JSON.parse(process.env.ZCODE_CAPTURE_PLAN || fs.readFileSync(path.join(RECEIVED, 'capture-plan.json'), 'utf8'))
const NODE = process.env.DSH_ZCODE_NODE || process.execPath

fs.mkdirSync(PENDING, { recursive: true })
fs.mkdirSync(RECEIVED, { recursive: true })

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function readCredential() {
  if (!fs.existsSync(CRED_FILE)) return null
  try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')) } catch { return null }
}

// Stage 1 of the pipeline: ask the coordinator for a per-round object key and the
// RSA public key. The private key for that public key never reaches this side.
function requestCredential(timeoutMs) {
  fs.rmSync(CRED_FILE, { force: true })
  const payload = JSON.stringify({ workspacePath: PLAN.workspace, kind: PLAN.kind || 'baseline' })
  const deadline = Date.now() + timeoutMs
  let lastError = 'unknown'
  while (Date.now() < deadline) {
    const result = spawnSync('curl', [
      '-sS', '-f', '--max-time', '20', '-X', 'POST', PLAN.endpoint,
      '-H', 'content-type: application/json', '-d', payload, '-o', CRED_FILE,
    ], { encoding: 'utf8' })
    if (result.status === 0) {
      const credential = readCredential()
      if (credential && credential.snapshot_id) return credential
      lastError = 'malformed credential response'
    } else {
      lastError = (result.stderr || '').trim() || 'curl exit ' + result.status
    }
    sleep(500)
  }
  throw new Error('COORDINATOR_UNREACHABLE: ' + lastError + ' from ' + (PLAN.endpoint || 'unknown'))
}

const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'pending', 'lost+found'])
const EXCLUDED_SUFFIXES = ['.enc', '.tar.gz', '.tmp', '.pid']

function walk(root, relative, files) {
  const entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true })
  for (const entry of entries) {
    const rel = relative ? relative + '/' + entry.name : entry.name
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue
      walk(root, rel, files)
      continue
    }
    if (!entry.isFile()) continue
    if (EXCLUDED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue
    if (entry.name === 'receiver.json') continue
    files.push(rel)
  }
}

const workspace = PLAN.workspace
const files = []
walk(workspace, '', files)

const buckets = { gitObjects: 0, gitLfs: 0, gitLogs: 0, gitOther: 0, other: 0 }
let totalBytes = 0
const tracked = []
for (const rel of files) {
  const size = fs.statSync(path.join(workspace, rel)).size
  totalBytes += size
  tracked.push([rel, size])
  if (rel.startsWith('.git/objects/')) buckets.gitObjects += size
  else if (rel.startsWith('.git/lfs/')) buckets.gitLfs += size
  else if (rel.startsWith('.git/logs/')) buckets.gitLogs += size
  else if (rel.startsWith('.git/')) buckets.gitOther += size
  else buckets.other += size
}

// The extra manifest hashes global app config that travels with every snapshot.
const extraManifest = []
for (const candidate of PLAN.extraManifest || []) {
  if (!fs.existsSync(candidate)) continue
  const bytes = fs.readFileSync(candidate)
  extraManifest.push({ path: candidate, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length })
}

const manifest = {
  kind: PLAN.kind || 'baseline',
  workspacePath: workspace,
  fileCount: files.length,
  totalBytes,
  buckets,
  gitSharePercent: Math.round(((buckets.gitObjects + buckets.gitLfs + buckets.gitLogs + buckets.gitOther) / Math.max(totalBytes, 1)) * 1000) / 10,
  extraManifest,
  generatedAt: new Date().toISOString(),
  files: tracked,
}
fs.writeFileSync(path.join(RECEIVED, 'manifest.json'), JSON.stringify(manifest, null, 2))

// --- pack -------------------------------------------------------------------
execFileSync('tar', [
  '-czf', PLAN.archive,
  '--exclude=./node_modules', '--exclude=./.git/lfs/tmp',
  '-C', workspace, '.',
], { stdio: 'pipe' })
const archiveBytes = fs.statSync(PLAN.archive).size

// --- encrypt (AES-256-CTR + RSA-OAEP-SHA256 envelope key, key from the server) ---
const credential = requestCredential(20000)
fs.writeFileSync(CRED_FILE + '.consumed', JSON.stringify(credential))
const key = crypto.randomBytes(32)
const iv = crypto.randomBytes(16)
const cipher = crypto.createCipheriv('aes-256-ctr', key, iv)
const ciphertext = Buffer.concat([cipher.update(fs.readFileSync(PLAN.archive)), cipher.final()])
const encryptedKey = crypto.publicEncrypt(
  { key: credential.encryption.public_key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
  key,
)
const encryptedPath = path.join(PENDING, credential.snapshot_id + '.tar.gz.enc')
fs.writeFileSync(encryptedPath, ciphertext)

fs.writeFileSync(path.join(PENDING, credential.snapshot_id + '.json'), JSON.stringify({
  workspacePath: workspace,
  snapshotId: credential.snapshot_id,
  kind: PLAN.kind || 'baseline',
  lastCompressedSize: { workspaceSizeBytes: totalBytes, archiveSizeBytes: archiveBytes, encryptedSizeBytes: ciphertext.length },
  failureCount: 0,
}, null, 2))

// --- direct form POST straight to storage (bypasses the app server) ----------
const boundary = '----zcodeLocalFormBoundary' + crypto.randomBytes(8).toString('hex')
const fields = {
  snapshot_id: credential.snapshot_id,
  keywrap_algorithm: 'rsa-oaep-sha256',
  workspace_path: workspace,
  iv: iv.toString('base64'),
  encrypted_key: encryptedKey.toString('base64'),
  client_manifest: JSON.stringify({ fileCount: manifest.fileCount, totalBytes: manifest.totalBytes, buckets: manifest.buckets, gitSharePercent: manifest.gitSharePercent, extraManifest }),
  extra_manifest: extraManifest.map((entry) => `${entry.sha256}  ${entry.path}`).join('\n'),
}
const chunks = []
for (const [name, value] of Object.entries(fields)) {
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
}
chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${credential.snapshot_id}.tar.gz.enc"\r\nContent-Type: application/octet-stream\r\n\r\n`))
chunks.push(ciphertext)
chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`))
const body = Buffer.concat(chunks)
const bodyPath = path.join(PENDING, credential.snapshot_id + '.post.body')
fs.writeFileSync(bodyPath, body)

const url = `http://${credential.upload.host}:${credential.upload.port}${credential.upload.path}`
const started = Date.now()
const result = spawnSync('curl', [
  '-sS', '--max-time', '60', '-X', 'POST', url,
  '-H', `Content-Type: multipart/form-data; boundary=${boundary}`,
  '--data-binary', '@' + bodyPath,
], { encoding: 'utf8' })

const report = {
  ok: result.status === 0,
  status: result.status,
  url,
  durationMs: Date.now() - started,
  response: (result.stdout || '').trim().slice(0, 2000),
  stderr: (result.stderr || '').trim().slice(0, 500),
  snapshotId: credential.snapshot_id,
  fileCount: manifest.fileCount,
  workspaceSizeBytes: totalBytes,
  archiveSizeBytes: archiveBytes,
  encryptedSizeBytes: ciphertext.length,
  buckets,
  gitSharePercent: manifest.gitSharePercent,
  extraManifest,
  encryptedAt: encryptedPath,
  manifest,
  capturedAt: new Date().toISOString(),
}
fs.writeFileSync(STATE_FILE, JSON.stringify(report, null, 2))
fs.writeFileSync(path.join(PENDING, credential.snapshot_id + '.json'), JSON.stringify({
  workspacePath: workspace,
  snapshotId: credential.snapshot_id,
  kind: PLAN.kind || 'baseline',
  lastCompressedSize: { workspaceSizeBytes: totalBytes, archiveSizeBytes: archiveBytes, encryptedSizeBytes: ciphertext.length },
  failureCount: result.status === 0 ? 0 : 1,
}, null, 2))

console.log(JSON.stringify({
  ok: report.ok,
  snapshotId: report.snapshotId,
  fileCount: report.fileCount,
  workspaceSizeBytes: report.workspaceSizeBytes,
  encryptedSizeBytes: report.encryptedSizeBytes,
  gitSharePercent: report.gitSharePercent,
  httpStatus: report.status,
  response: report.response,
}, null, 2))
if (!report.ok) process.exit(1)
