#!/usr/bin/env node
// What the "cloud" can see once it unwraps the envelope with the private key it alone holds.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')

const NODE = process.env.DSH_ZCODE_NODE || process.execPath
const ROOT = path.join(process.env.HOME, '.zcode-local')
const CLOUD = path.join(ROOT, 'cloud', 'snapshots')
const RECEIVED = path.join(ROOT, 'received')
const INDEX = path.join(CLOUD, 'index.json')
const STATE_FILE = path.join(RECEIVED, 'verify-state.json')
const REPORT = path.join(RECEIVED, 'verification-report.md')

const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'))
const accepted = index.filter((entry) => entry.status === 'accepted' && entry.plaintextBytes)
if (accepted.length === 0) {
  console.log(JSON.stringify({ ok: false, reason: 'no accepted snapshot on the mock cloud yet' }, null, 2))
  process.exit(1)
}
const entry = accepted[accepted.length - 1]
const plaintext = path.join(CLOUD, path.basename(entry.storedAt) + '.decrypted.tar.gz')
if (!fs.existsSync(plaintext)) {
  console.log(JSON.stringify({ ok: false, reason: 'decrypted payload missing: ' + plaintext }, null, 2))
  process.exit(1)
}

const extractTo = path.join(ROOT, 'cloud', 'extracted', entry.snapshotId)
fs.rmSync(extractTo, { recursive: true, force: true })
fs.mkdirSync(extractTo, { recursive: true })
execFileSync('tar', ['-xzf', plaintext, '-C', extractTo], { stdio: 'pipe' })

function walk(root, relative, files) {
  for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = relative ? relative + '/' + item.name : item.name
    if (item.isDirectory()) walk(root, rel, files)
    else if (item.isFile()) files.push(rel)
  }
  return files
}
const extractedFiles = walk(extractTo, '', [])
const extractedBytes = extractedFiles.reduce((sum, rel) => sum + fs.statSync(path.join(extractTo, rel)).size, 0)

const manifest = entry.clientManifest || {}
const checks = {
  fileCountSent: manifest.fileCount ?? null,
  fileCountReceived: extractedFiles.length,
  fileCountMatches: manifest.fileCount === extractedFiles.length,
  totalBytesSent: manifest.totalBytes ?? null,
  totalBytesReceived: extractedBytes,
  bytesDeltaPercent: manifest.totalBytes ? Math.round(Math.abs(extractedBytes - manifest.totalBytes) / manifest.totalBytes * 1000) / 10 : null,
  wholeGitHistoryReceived: extractedFiles.some((rel) => rel === '.git' || rel.startsWith('.git/')),
  gitObjectFiles: extractedFiles.filter((rel) => rel.startsWith('.git/objects/')).length,
  gitLfsCacheBytes: extractedFiles.filter((rel) => rel.startsWith('.git/lfs/')).reduce((sum, rel) => sum + fs.statSync(path.join(extractTo, rel)).size, 0),
  reflogPresent: fs.existsSync(path.join(extractTo, '.git/logs/HEAD')),
}

// What a curious backend engineer would immediately grep out of the pile.
const gitConfigPath = path.join(extractTo, '.git/config')
const gitRemotes = fs.existsSync(gitConfigPath)
  ? [...fs.readFileSync(gitConfigPath, 'utf8').matchAll(/url\s*=\s*(.+)/g)].map((match) => match[1].trim())
  : []
const stdoutOf = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim()
const branches = spawnSync('git', ['branch', '-a', '--format=%(refname:short)'], { cwd: extractTo, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
const deletedSecretStillRecoverable = (() => {
  const objects = spawnSync('bash', ['-c', `git -C ${JSON.stringify(extractTo)} rev-list --objects --all | grep -c .env.local || true`], { encoding: 'utf8' }).stdout.trim()
  return objects !== '' && objects !== '0'
})()
const secretBlob = (() => {
  const found = spawnSync('bash', ['-c', `git -C ${JSON.stringify(extractTo)} log --all --diff-filter=A --format=%H -- src/.env.local | head -1`], { encoding: 'utf8' }).stdout.trim()
  if (!found) return null
  const blob = spawnSync('bash', ['-c', `git -C ${JSON.stringify(extractTo)} show ${found}:src/.env.local 2>/dev/null | head -3`], { encoding: 'utf8' }).stdout.trim()
  return blob || null
})()
const unpushedBranches = branches.filter((name) => !name.startsWith('origin/') && name !== 'main' && name !== 'master')
const log = stdoutOf(['log', '--oneline', '--all'], extractTo)

const report = [
  '# Verification: what the mock cloud received',
  '',
  `- snapshot: \`${entry.snapshotId}\``,
  `- object key: \`${entry.objectKey}\``,
  `- status: **${entry.status}** (envelope key unwrap: ${entry.keyUnwrap})`,
  `- ciphertext stored by the cloud: ${entry.ciphertextBytes} bytes (sha256 \`${String(entry.sha256).slice(0, 16)}…\`)`,
  `- plaintext after unwrapping: ${entry.plaintextBytes} bytes`,
  `- shipped by the client: ${manifest.fileCount ?? '?'} files / ${manifest.totalBytes ?? '?'} bytes / .git share ${manifest.gitSharePercent ?? '?'}%`,
  `- received by the cloud: ${extractedFiles.length} files / ${extractedBytes} bytes`,
  '',
  '## Integrity checks',
  '',
  '| check | result |',
  '| --- | --- |',
  `| file count matches what the client sent | ${checks.fileCountMatches ? 'yes' : 'NO'} (${checks.fileCountReceived}/${checks.fileCountSent}) |`,
  `| byte delta vs client manifest | ${checks.bytesDeltaPercent}% |`,
  `| complete \`.git\` directory present | ${checks.wholeGitHistoryReceived ? 'yes' : 'no'} |`,
  `| git object files | ${checks.gitObjectFiles} |`,
  `| LFS cache bytes | ${checks.gitLfsCacheBytes} |`,
  `| reflog \`.git/logs/HEAD\` present | ${checks.reflogPresent ? 'yes' : 'no'} |`,
  '',
  '## Exactly what leaked',
  '',
  '| leaked artifact | value found in the shipment |',
  '| --- | --- |',
  `| git remote (internal hostname + repo path) | ${gitRemotes.join(' , ') || 'none'} |`,
  `| local branch names, including unpushed work | ${branches.join(', ') || 'none'} |`,
  `| unpushed branch names only | ${unpushedBranches.join(', ') || 'none'} |`,
  `| deleted \`.env.local\` still recoverable from history | ${deletedSecretStillRecoverable ? 'yes' : 'no'} |`,
  `| secret read straight out of the object store | ${secretBlob ? '`' + secretBlob.replace(/\n/g, '\\n') + '`' : 'not recovered'} |`,
  '',
  '### Commit history received',
  '',
  '```',
  log,
  '```',
  '',
  '## Why local defenders cannot undo it',
  '',
  `- The envelope key was wrapped with an RSA public key handed out per request by the coordinator; the matching private key lives at \`${path.join(ROOT, 'cloud', 'receiver-private.pem')}\`, i.e. outside the workspace tree entirely.`,
  '- The client-tagged key version (`encryption.key_version`) is metadata only; the client never holds a decryption path.',
  '- Deleting the local `.tar.gz.enc` is whack-a-mole: the capture trigger simply packs a new one.',
  '- The only kernel-level stop is making the staging directory immutable, which is what the article recommends.',
  '',
  `_generated ${new Date().toISOString()}_`,
  '',
].join('\n')
fs.writeFileSync(REPORT, report)

const summary = {
  ok: true,
  snapshotId: entry.snapshotId,
  status: entry.status,
  ciphertextBytes: entry.ciphertextBytes,
  plaintextBytes: entry.plaintextBytes,
  fileCountReceived: extractedFiles.length,
  fileCountMatches: checks.fileCountMatches,
  wholeGitHistoryReceived: checks.wholeGitHistoryReceived,
  gitObjectFiles: checks.gitObjectFiles,
  gitLfsCacheBytes: checks.gitLfsCacheBytes,
  reflogPresent: checks.reflogPresent,
  gitRemotes,
  branches,
  unpushedBranches,
  deletedSecretStillRecoverable,
  secretExcerpt: secretBlob,
  report: REPORT,
  extractedTo: extractTo,
}
fs.writeFileSync(STATE_FILE, JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
