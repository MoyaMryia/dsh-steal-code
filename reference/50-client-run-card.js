// Optional browser half for the Cordis Run card.
//
// A real DSH preset cannot ship a browser half without a bundler, so this file is
// NOT loaded by agent.cordis.yml. It is the Client section of a dynamic Cordis
// Package: define a Package whose `code.client` is this file's body (and whose
// `code.host` drives the same reference scripts), then run it. The panel shows
// staged ciphertext, trigger counters and the client manifest bytes for the
// latest capture, and offers Capture / Verify / Read report controls.
//
// It talks to the host half through four Package-private methods:
//   status -> the snapshot object built by the host half
//   capture { trigger } -> run one capture
//   verify {} -> have the mock cloud decrypt and audit
//   read-report {} -> { markdown } of the generated report
//
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    const CSS = [
      '.zcl-panel{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--border-weak,rgba(127,127,127,.28));border-radius:8px;padding:10px 12px;margin-top:8px;display:flex;flex-direction:column;gap:8px;background:var(--bg-raised,rgba(127,127,127,.05))}',
      '.zcl-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.zcl-title{font-weight:600}',
      '.zcl-tag{border-radius:4px;padding:1px 6px;border:1px solid var(--border-weak,rgba(127,127,127,.35));opacity:.85}',
      '.zcl-tag.on{color:#15803d;border-color:rgba(21,128,61,.5);background:rgba(21,128,61,.10)}',
      '.zcl-tag.off{color:#b91c1c;border-color:rgba(185,28,28,.5);background:rgba(185,28,28,.10)}',
      '.zcl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px}',
      '.zcl-cell{border:1px solid var(--border-weak,rgba(127,127,127,.22));border-radius:6px;padding:5px 7px;display:flex;flex-direction:column;gap:1px}',
      '.zcl-cell b{font-weight:600;font-size:12.5px}',
      '.zcl-cell span{opacity:.62;font-size:11px}',
      '.zcl-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.zcl-btn{font:inherit;cursor:pointer;border-radius:6px;padding:4px 10px;border:1px solid var(--border-weak,rgba(127,127,127,.4));background:transparent;color:inherit}',
      '.zcl-btn:hover{background:rgba(127,127,127,.14)}',
      '.zcl-btn:disabled{opacity:.45;cursor:progress}',
      '.zcl-details summary{cursor:pointer;opacity:.75}',
      '.zcl-kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 10px;margin-top:6px}',
      '.zcl-kv i{opacity:.6;font-style:normal}',
      '.zcl-kv em{font-style:normal;word-break:break-all}',
      '.zcl-secret{color:#b91c1c;white-space:pre-wrap;word-break:break-all}',
      '.zcl-note{opacity:.6;font-size:11px}',
    ].join('')

    ctx.effect(() => styles.insert(CSS), 'zcode-local:styles')

    function bytes(value) {
      if (typeof value !== 'number' || !isFinite(value)) return '—'
      const units = ['B', 'KB', 'MB', 'GB']
      let index = 0
      let size = value
      while (size >= 1024 && index < units.length - 1) { size = size / 1024; index++ }
      return (index === 0 ? size : size.toFixed(1)) + ' ' + units[index]
    }

    function Cell(label, value) {
      return React.createElement('div', { className: 'zcl-cell', key: label }, [
        React.createElement('span', { key: 'l' }, label),
        React.createElement('b', { key: 'v' }, value),
      ])
    }

    function Row(label, value, tone) {
      return React.createElement(React.Fragment, { key: label }, [
        React.createElement('i', { key: 'l' }, label),
        React.createElement('em', { key: 'v', className: tone === 'alert' ? 'zcl-secret' : null }, value),
      ])
    }

    function Panel(props) {
      const [snap, setSnap] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [markdown, setMarkdown] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        const poll = async () => {
          try {
            const next = await host.call('status')
            if (alive && next) setSnap(next)
          } catch (error) {
            if (alive) setSnap({ phase: 'error', message: String(error && error.message) })
          }
        }
        poll()
        const timer = setInterval(poll, 2500)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      const onCapture = async () => {
        setBusy('capture')
        try { setSnap(await host.call('capture', { trigger: 'manual' })) }
        catch (error) { setSnap({ phase: 'error', message: String(error && error.message) }) }
        finally { setBusy('') }
      }

      const onVerify = async () => {
        setBusy('verify')
        try { setSnap(await host.call('verify', {})) }
        catch (error) { setSnap({ phase: 'error', message: String(error && error.message) }) }
        finally { setBusy('') }
      }

      const onReport = async () => {
        try {
          const result = await host.call('read-report', {})
          setMarkdown(result && result.markdown ? result.markdown : 'no report yet')
        } catch (error) { setMarkdown(String(error && error.message)) }
      }

      const view = snap || { phase: 'starting', message: 'waiting for the sidecar', triggers: {} }
      const capture = view.lastCapture
      const verify = view.lastVerify
      const bucket = capture && capture.buckets ? capture.buckets : null
      const rows = []
      if (capture) {
        rows.push(Row('snapshot id', capture.snapshotId || '—'))
        rows.push(Row('cloud response', String(capture.cloudResponse || '').slice(0, 160) || '—'))
        if (bucket) rows.push(Row('git objects / LFS / logs', bytes(bucket.gitObjects) + ' / ' + bytes(bucket.gitLfs) + ' / ' + bytes(bucket.gitLogs)))
        rows.push(Row('packed files', String(capture.fileCount || 0)))
        rows.push(Row('encrypted size', bytes(capture.encryptedSizeBytes)))
        rows.push(Row('git share of payload', String(capture.gitSharePercent) + '%'))
        rows.push(Row('extra global-config manifest', (capture.extraManifest || []).map((entry) => entry.path + ' (' + entry.sha256.slice(0, 12) + '…)').join(', ') || 'none'))
      }
      if (verify) {
        rows.push(Row('server-side decrypt', verify.fileCountMatches ? 'yes — ' + verify.fileCountReceived + ' files, byte-identical to the client manifest' : 'mismatch'))
        rows.push(Row('complete .git received', verify.wholeGitHistoryReceived ? 'yes (' + verify.gitObjectFiles + ' object files, reflog ' + (verify.reflogPresent ? 'present' : 'absent') + ')' : 'no'))
        rows.push(Row('internal git remote', (verify.gitRemotes || []).join(', ') || 'none', 'alert'))
        rows.push(Row('unpushed branches', (verify.unpushedBranches || []).join(', ') || 'none', 'alert'))
        rows.push(Row('deleted secret recoverable', verify.deletedSecretStillRecoverable ? 'yes' : 'no', 'alert'))
        if (verify.secretExcerpt) rows.push(Row('secret read from object store', verify.secretExcerpt, 'alert'))
      }

      const children = [
        React.createElement('div', { className: 'zcl-head', key: 'head' }, [
          React.createElement('span', { className: 'zcl-title', key: 't' }, 'ZCode silent-snapshot reproduction'),
          React.createElement('span', { key: 'local', className: 'zcl-tag on' }, 'local only · 127.0.0.1:9099'),
          React.createElement('span', { key: 'worker', className: 'zcl-tag ' + (view.receiver === 'up (127.0.0.1:9099)' ? 'on' : 'off') }, 'worker ' + (view.receiver || 'unknown')),
          React.createElement('span', { key: 'phase', className: 'zcl-tag' }, view.phase + (busy ? '…' : '')),
        ]),
        React.createElement('div', { className: 'zcl-note', key: 'msg' }, view.message || ''),
        React.createElement('div', { className: 'zcl-row', key: 'triggers' }, [
          React.createElement('span', { key: 'a', className: 'zcl-tag on' }, 'captureBeforePrompt: ' + ((view.triggers || {}).captureBeforePrompt || 0)),
          React.createElement('span', { key: 'b', className: 'zcl-tag on' }, 'repo-wiki-update: ' + ((view.triggers || {})['repo-wiki-update'] || 0)),
          React.createElement('span', { key: 'c', className: 'zcl-tag ' + (view.pendingCount > 0 ? 'off' : 'on') }, 'staged ciphertext: ' + (view.pendingCount || 0) + ' (' + bytes((capture && capture.encryptedSizeBytes) || 0) + ')'),
          React.createElement('span', { key: 'd', className: 'zcl-tag' }, 'failureCount: ' + (view.failureCount || 0)),
          React.createElement('span', { key: 'e', className: 'zcl-tag' }, 'optimizeAgentExperienceEnabled: false → still uploading'),
        ]),
        React.createElement('div', { className: 'zcl-grid', key: 'grid' }, [
          Cell('workspace bytes', capture ? bytes(capture.workspaceSizeBytes) : '—'),
          Cell('packed files', capture ? String(capture.fileCount) : '—'),
          Cell('encrypted bytes', capture ? bytes(capture.encryptedSizeBytes) : '—'),
          Cell('.git share', capture ? capture.gitSharePercent + '%' : '—'),
        ]),
        React.createElement('div', { className: 'zcl-row', key: 'actions' }, [
          React.createElement('button', { key: 'c', className: 'zcl-btn', disabled: busy !== '', onClick: onCapture }, busy === 'capture' ? 'packing…' : 'Capture now'),
          React.createElement('button', { key: 'v', className: 'zcl-btn', disabled: busy !== '', onClick: onVerify }, busy === 'verify' ? 'verifying…' : 'Verify what the cloud got'),
          React.createElement('button', { key: 'r', className: 'zcl-btn', onClick: onReport }, 'Read report'),
        ]),
      ]

      if (rows.length > 0) {
        children.push(React.createElement('details', { className: 'zcl-details', key: 'details' }, [
          React.createElement('summary', { key: 's' }, 'what was shipped' + (markdown ? '' : ' / report')),
          React.createElement('div', { className: 'zcl-kv', key: 'kv' }, rows),
        ]))
      }
      if (markdown) {
        children.push(React.createElement('pre', { key: 'md', style: { maxHeight: '320px', overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0, fontSize: '11px' } }, markdown.slice(0, 8000)))
      }
      children.push(React.createElement('div', { className: 'zcl-note', key: 'foot' }, 'No toggle here can stop the sidecar — the switches in the real client only gate training consent and server-side indexing.'))

      return React.createElement('div', { className: 'zcl-panel' }, children)
    }

    slots.inject('tool.view.cordis', () => slots.register(
      { name: 'tool.view.cordis', key: 'self' },
      (props) => React.createElement(Panel, { useSession: props.useSession }),
    ))
  },
}
