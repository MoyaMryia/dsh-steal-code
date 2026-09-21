#!/usr/bin/env node
// Mock "cloud" for the LOCAL ZCode-behaviour reproduction.
// Roles replayed, all on 127.0.0.1:
//   POST /api/v1/snapshot/upload-credential  -> snapshot_id + RSA public key (private key NEVER leaves here)
//   POST /oss/<objectKey>                    -> receives tar.gz.enc ciphertext
//   GET  /status                             -> what the "cloud" holds
//   POST /shutdown                           -> clean stop
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = path.join(process.env.HOME, '.zcode-local')
const RECEIVED = path.join(ROOT, 'received')
const PENDING = path.join(ROOT, 'v2', 'checkpoints', 'pending')
const SNAPSHOTS = path.join(ROOT, 'cloud', 'snapshots')
const KEY_FILE = path.join(ROOT, 'cloud', 'receiver-private.pem')
const PUB_FILE = path.join(ROOT, 'cloud', 'receiver-public.pem')
const CRED_LOG = path.join(RECEIVED, 'credentials.jsonl')
const UP_LOG = path.join(RECEIVED, 'uploads.jsonl')
const HOST = process.env.ZCODE_MOCK_HOST || '127.0.0.1'
const PORT = Number(process.env.ZCODE_MOCK_PORT || 9099)
const MAX_BYTES = 256 * 1024 * 1024

for (const dir of [RECEIVED, PENDING, SNAPSHOTS]) fs.mkdirSync(dir, { recursive: true })

let privateKey
if (fs.existsSync(KEY_FILE)) {
  privateKey = fs.readFileSync(KEY_FILE, 'utf8')
} else {
  const pair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  fs.writeFileSync(KEY_FILE, pair.privateKey)
  fs.writeFileSync(PUB_FILE, pair.publicKey)
  privateKey = pair.privateKey
}
// The client half is handed ONLY this public key; the private key never leaves RECEIVER_ROOT.
const publicKey = fs.readFileSync(PUB_FILE, 'utf8')

const indexFile = path.join(SNAPSHOTS, 'index.json')
let snapshots = new Map()
if (fs.existsSync(indexFile)) {
  try {
    for (const entry of JSON.parse(fs.readFileSync(indexFile, 'utf8'))) snapshots.set(entry.snapshotId, entry)
  } catch { /* start from a clean index */ }
}
const persist = () => fs.writeFileSync(indexFile, JSON.stringify([...snapshots.values()], null, 2))

const appendJsonl = (file, value) => fs.appendFileSync(file, JSON.stringify(value) + '\n')

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BYTES) { reject(new Error('MAX_SIZE_EXCEEDED')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// --- multipart/form-data (the OSS PostObject shape) -------------------------
function parseMultipart(buffer, contentType) {
  const match = /boundary=([^;]+)/.exec(contentType || '')
  if (!match) throw new Error('NO_BOUNDARY')
  const boundary = Buffer.from('--' + match[1].replace(/^"|"$/g, ''))
  const parts = []
  let cursor = buffer.indexOf(boundary)
  if (cursor < 0) throw new Error('NO_PART')
  cursor += boundary.length
  while (cursor < buffer.length) {
    if (buffer.slice(cursor, cursor + 2).toString() === '--') break
    if (buffer.slice(cursor, cursor + 2).toString() === '\r\n') cursor += 2
    const headerEnd = buffer.indexOf('\r\n\r\n', cursor)
    if (headerEnd < 0) break
    const header = buffer.slice(cursor, headerEnd).toString('utf8')
    const bodyStart = headerEnd + 4
    const next = buffer.indexOf(boundary, bodyStart)
    const bodyEnd = next < 0 ? buffer.length : next - 2
    const nameMatch = /name="([^"]+)"/.exec(header)
    if (nameMatch) parts.push({ name: nameMatch[1], value: buffer.slice(bodyStart, bodyEnd) })
    if (next < 0) break
    cursor = next + boundary.length
  }
  return parts
}

function parseStateFile(buf) {
  try { return JSON.parse(buf.toString('utf8')) } catch { return null }
}

// --- endpoints --------------------------------------------------------------
async function handleCredential(req, res) {
  const raw = await readBody(req)
  let request = {}
  try { request = JSON.parse(raw.toString('utf8') || '{}') } catch { request = {} }
  const workspacePath = String(request.workspacePath || '')
  const kind = String(request.kind || 'baseline')
  const existing = [...snapshots.values()].find((s) => s.workspacePath === workspacePath && s.kind === kind)
  if (existing) {
    json(res, 200, {
      snapshot_id: existing.snapshotId,
      object_key: existing.objectKey,
      max_size_bytes: MAX_BYTES,
      encryption: { key_version: 1, public_key: publicKey },
      upload: { method: 'POST', host: HOST, port: PORT, path: '/oss/' + existing.objectKey, content_type: 'multipart/form-data' },
    })
    return
  }
  const snapshotId = 'snap_' + crypto.randomUUID()
  const objectKey = 'repo-snapshots/' + crypto.randomBytes(8).toString('hex') + '.tar.gz.enc'
  const record = {
    snapshotId,
    objectKey,
    workspacePath,
    kind,
    status: 'credentialed',
    createdAt: new Date().toISOString(),
    ciphertextBytes: null,
    plaintextBytes: null,
    sha256: null,
    unwrappedWith: 'cloud-held RSA private key (never present on the client tree)',
    clientManifest: null,
    extraManifestCount: 0,
  }
  snapshots.set(snapshotId, record)
  persist()
  appendJsonl(CRED_LOG, { at: record.createdAt, snapshotId, workspacePath, kind })
  json(res, 200, {
    snapshot_id: snapshotId,
    object_key: objectKey,
    max_size_bytes: MAX_BYTES,
    encryption: { key_version: 1, public_key: publicKey },
    upload: { method: 'POST', host: HOST, port: PORT, path: '/oss/' + objectKey, content_type: 'multipart/form-data' },
  })
}

async function handleOssUpload(req, res, objectKey) {
  const raw = await readBody(req)
  const parts = parseMultipart(raw, req.headers['content-type'])
  let cipherBytes = null
  const meta = {}
  for (const part of parts) {
    if (part.name === 'file') cipherBytes = part.value
    else if (['snapshot_id', 'keywrap_algorithm', 'encrypted_key', 'iv', 'client_manifest', 'extra_manifest', 'workspace_path'].includes(part.name)) {
      meta[part.name] = part.value.toString('utf8')
    }
  }
  if (!cipherBytes) { json(res, 400, { error: 'MISSING_FILE_PART' }); return }
  const stored = path.join(SNAPSHOTS, objectKey.replace(/\//g, '__'))
  fs.writeFileSync(stored, cipherBytes)

  // The "cloud" is the only holder of the private key, so only it can unwrap the envelope key.
  const unwrap = () => {
    try {
      const key = crypto.privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(meta.encrypted_key || '', 'base64'),
      )
      const decipher = crypto.createDecipheriv('aes-256-ctr', key, Buffer.from(meta.iv || '', 'base64'))
      return Buffer.concat([decipher.update(cipherBytes), decipher.final()])
    } catch (error) {
      return { failure: String(error.message) }
    }
  }
  const outcome = unwrap()
  let plaintextBytes = null
  const failed = outcome && outcome.failure
  if (!failed) {
    plaintextBytes = outcome.length
    fs.writeFileSync(stored + '.decrypted.tar.gz', outcome)
  }
  const entry = snapshots.get(meta.snapshot_id) || { snapshotId: meta.snapshot_id, objectKey }
  snapshots.set(meta.snapshot_id, {
    ...entry,
    objectKey,
    status: failed ? 'rejected' : 'accepted',
    receivedAt: new Date().toISOString(),
    ciphertextBytes: cipherBytes.length,
    plaintextBytes,
    sha256: crypto.createHash('sha256').update(cipherBytes).digest('hex'),
    keyUnwrap: failed ? 'FAILED: ' + failed : 'OK (RSA-OAEP-SHA256)',
    clientManifest: meta.client_manifest ? JSON.parse(meta.client_manifest) : null,
    extraManifestCount: meta.extra_manifest ? String(meta.extra_manifest).split('\n').length : 0,
    storedAt: stored,
  })
  persist()
  appendJsonl(UP_LOG, { at: new Date().toISOString(), snapshotId: meta.snapshot_id, objectKey, ciphertextBytes: cipherBytes.length, plaintextBytes, keyUnwrap: failed ? 'failed' : 'ok' })
  json(res, 200, { ok: !failed, snapshot_id: meta.snapshot_id, status: failed ? 'rejected' : 'accepted', bytes: cipherBytes.length })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const route = async () => {
    if (req.method === 'POST' && url.pathname === '/api/v1/snapshot/upload-credential') return handleCredential(req, res)
    if (req.method === 'POST' && url.pathname.startsWith('/oss/')) return handleOssUpload(req, res, url.pathname.slice('/oss/'.length))
    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, { objectCount: snapshots.size, pendingLocal: fs.readdirSync(PENDING), snapshots: [...snapshots.values()] })
    }
    if (req.method === 'POST' && url.pathname === '/shutdown') {
      json(res, 200, { ok: true })
      setTimeout(() => process.exit(0), 20)
      return
    }
    return json(res, 404, { error: 'NOT_FOUND' })
  }
  route().catch((error) => { try { json(res, 500, { error: String(error.message) }) } catch { /* socket already gone */ } })
})

server.listen(PORT, HOST, () => {
  fs.writeFileSync(path.join(ROOT, 'receiver.json'), JSON.stringify({ pid: process.pid, host: HOST, port: PORT, startedAt: new Date().toISOString() }))
  console.log(`[mock-cloud] listening on http://${HOST}:${PORT}`)
  console.log(`[mock-cloud] private key: ${KEY_FILE}`)
})
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
