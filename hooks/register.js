// git-mod: a /git side panel for the repository in the session's directory.
// Shows the branch (and the branch it came from), changed files with
// Stage / Unstage buttons, AI-written commit messages, pull, push, and stashes with
// AI-written titles. Everything runs through `git` (a real executable on both
// Windows and macOS, so no shell or platform branch is needed).
// Helpers that take $ are top-level functions: static analysis refuses $
// passed to nested or imported functions.

const PANE = 'git-mod'
const MODEL = 'haiku' // model for commit messages and stash titles
const POLL_MS = 3000 // refresh interval while the panel is open
const BASE_BRANCHES = ['develop', 'dev', 'development', 'main', 'master']
const WATCHED_TOOLS = ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']

const KIND = {
  added: { glyph: '+', color: 'green', label: 'added' },
  modified: { glyph: '~', color: 'yellow', label: 'modified' },
  deleted: { glyph: '-', color: 'red', label: 'deleted' },
  renamed: { glyph: '→', color: 'cyan', label: 'renamed' },
  conflict: { glyph: '!', color: 'magenta', label: 'conflict' },
}

// Module state: rebuilt by the next refresh after a hot reload
let paneOpen = false
let refreshing = false
let loaded = false
let repo = null // { error } | { root, branch, oid, upstream, ahead, behind, isDetached, isUnborn }
let files = [] // { path, orig, x, y, isUntracked, isConflict }
let stashes = [] // { ref, hash, title, branch, when }
let parentOf = { branch: '', parent: '' }
let lastSig = ''
let busy = '' // label of the running action, '' when idle
let notice = null // { tone: 'ok' | 'error' | 'info', text, hash? }
let draft = null // { subject, body, isEditing }
let stashesOpen = true
let confirmDrop = '' // hash of the stash waiting for a second press to remove it

// ---------- git ----------

async function git($, args, init) {
  const opts = init ?? {}
  try {
    const r = await $.process.run(['git', '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], {
      timeoutMs: opts.timeoutMs ?? 20000,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    })
    return {
      ok: r.exitCode === 0,
      out: String(r.stdout ?? '').replace(/\r\n/g, '\n'),
      err: String(r.stderr ?? '').replace(/\r\n/g, '\n').trim(),
    }
  } catch (err) {
    return { ok: false, out: '', err: 'git could not start: ' + (err?.message ?? err), isMissing: true }
  }
}

// Runs git in the repository root
async function gitRoot($, args, init) {
  return git($, args, { ...(init ?? {}), cwd: repo?.root })
}

export function parseStatus(out) {
  const info = { branch: '', oid: '', upstream: '', ahead: 0, behind: 0 }
  const list = []
  const tokens = out.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!t) continue
    if (t.startsWith('# ')) {
      const [, key, ...rest] = t.split(' ')
      const val = rest.join(' ')
      if (key === 'branch.oid') info.oid = val
      else if (key === 'branch.head') info.branch = val
      else if (key === 'branch.upstream') info.upstream = val
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(val)
        if (m) {
          info.ahead = Number(m[1])
          info.behind = Number(m[2])
        }
      }
    } else if (t[0] === '1') {
      const parts = t.split(' ')
      list.push({ path: parts.slice(8).join(' '), orig: '', x: parts[1][0], y: parts[1][1], isUntracked: false, isConflict: false })
    } else if (t[0] === '2') {
      const parts = t.split(' ')
      const orig = tokens[++i] ?? ''
      list.push({ path: parts.slice(9).join(' '), orig, x: parts[1][0], y: parts[1][1], isUntracked: false, isConflict: false })
    } else if (t[0] === 'u') {
      const parts = t.split(' ')
      list.push({ path: parts.slice(10).join(' '), orig: '', x: 'U', y: 'U', isUntracked: false, isConflict: true })
    } else if (t[0] === '?') {
      list.push({ path: t.slice(2), orig: '', x: '.', y: '?', isUntracked: true, isConflict: false })
    }
  }
  return { info, list }
}

export function parseStashes(out) {
  return out
    .split('\x1e')
    .map((rec) => rec.replace(/^\n+/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [ref, hash, subject = '', when = ''] = rec.split('\x1f')
      let title = subject
      let branch = ''
      let m = /^On ([^:]+): (.*)$/s.exec(subject)
      if (m) {
        branch = m[1]
        title = m[2]
      } else if ((m = /^WIP on ([^:]+): (.*)$/s.exec(subject))) {
        branch = m[1]
        title = 'WIP · ' + m[2]
      }
      return { ref, hash, title: title.trim(), branch, when: when.trim() }
    })
}

function kindOf(code) {
  if (code === 'A' || code === '?') return 'added'
  if (code === 'D') return 'deleted'
  if (code === 'R' || code === 'C') return 'renamed'
  if (code === 'U') return 'conflict'
  return 'modified'
}

function stagedFiles() {
  return files.filter((f) => !f.isUntracked && !f.isConflict && f.x !== '.')
}

function unstagedFiles() {
  return files.filter((f) => f.isUntracked || f.isConflict || f.y !== '.')
}

// The branch this one was created from: its own reflog, then HEAD's reflog,
// then the nearest of the usual base branches by commits ahead.
async function detectParent($, branch) {
  const refsRes = await gitRoot($, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])
  const refs = new Set(refsRes.out.split('\n').map((s) => s.trim()).filter(Boolean))
  const known = (name) => name && name !== branch && name !== 'HEAD' && refs.has(name)

  const own = await gitRoot($, ['reflog', 'show', '--format=%gs', 'refs/heads/' + branch, '--'])
  if (own.ok) {
    const lines = own.out.trim().split('\n')
    const m = /^branch: Created from (.+)$/.exec(lines[lines.length - 1] ?? '')
    const from = m ? m[1].replace(/^refs\/(heads|remotes)\//, '') : ''
    if (known(from)) return from
  }

  const head = await gitRoot($, ['reflog', 'show', '--format=%gs', '-n', '5000', 'HEAD', '--'])
  if (head.ok) {
    const lines = head.out.trim().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /^checkout: moving from (.+) to (.+)$/.exec(lines[i])
      if (m && m[2] === branch && known(m[1])) return m[1]
    }
  }

  let best = ''
  let bestCount = Infinity
  for (const name of BASE_BRANCHES) {
    const candidate = refs.has(name) ? name : [...refs].find((r) => r.endsWith('/' + name) && !r.endsWith('/HEAD')) ?? ''
    if (!known(candidate)) continue
    const r = await gitRoot($, ['rev-list', '--count', candidate + '..HEAD'])
    const n = Number(r.out.trim())
    if (r.ok && n < bestCount) {
      best = candidate
      bestCount = n
    }
  }
  return best
}

async function refresh($) {
  if (refreshing) return
  refreshing = true
  try {
    const top = await git($, ['rev-parse', '--show-toplevel'])
    if (!top.ok) {
      repo = { error: top.isMissing ? 'git is not installed or not on PATH.' : 'Not inside a git repository.' }
      files = []
      stashes = []
    } else {
      const root = top.out.trim()
      const st = await git($, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], { cwd: root })
      const { info, list } = parseStatus(st.out)
      repo = {
        root,
        branch: info.branch,
        oid: info.oid,
        upstream: info.upstream,
        ahead: info.ahead,
        behind: info.behind,
        isDetached: info.branch === '(detached)',
        isUnborn: info.oid === '(initial)',
      }
      files = list
      const sl = await git($, ['stash', 'list', '--format=%gd%x1f%h%x1f%gs%x1f%cr%x1e'], { cwd: root })
      stashes = sl.ok ? parseStashes(sl.out) : []

      const b = repo.branch
      if (parentOf.branch !== b) {
        const parent = b.includes('/') && !repo.isDetached && !repo.isUnborn ? await detectParent($, b) : ''
        parentOf = { branch: b, parent }
      }
    }
    loaded = true
    const sig = JSON.stringify([repo, files, stashes, parentOf])
    if (sig !== lastSig) {
      lastSig = sig
      $.ui.invalidate('ui.render')
    }
  } finally {
    refreshing = false
  }
}

function setNotice($, tone, text, hash) {
  notice = { tone, text, ...(hash ? { hash } : {}) }
  $.ui.invalidate('ui.render')
}

function lastLines(text, n) {
  return text.trim().split('\n').filter(Boolean).slice(-n).join('\n')
}

// Runs one action at a time; shows a working line while it runs
async function runAction($, label, work) {
  if (busy) {
    $.ui.toast('git-mod is busy: ' + busy)
    return
  }
  busy = label
  $.ui.invalidate('ui.render')
  try {
    await work()
  } catch (err) {
    setNotice($, 'error', label + ' failed: ' + (err?.message ?? err))
  } finally {
    busy = ''
    lastSig = ''
    await refresh($)
    $.ui.invalidate('ui.render')
  }
}

// ---------- actions ----------

async function stageFile($, f) {
  const r = await gitRoot($, ['add', '-A', '--', f.path])
  if (!r.ok) setNotice($, 'error', 'Could not stage ' + f.path + ':\n' + lastLines(r.err, 4))
}

async function unstageFile($, f) {
  const paths = f.orig ? [f.path, f.orig] : [f.path]
  const r = repo.isUnborn
    ? await gitRoot($, ['rm', '--cached', '-r', '-q', '--', ...paths])
    : await gitRoot($, ['restore', '--staged', '--', ...paths])
  if (!r.ok) setNotice($, 'error', 'Could not unstage ' + f.path + ':\n' + lastLines(r.err, 4))
}

async function stageAll($) {
  const r = await gitRoot($, ['add', '-A'])
  if (!r.ok) setNotice($, 'error', 'Could not stage all:\n' + lastLines(r.err, 4))
}

async function unstageAll($) {
  const r = repo.isUnborn ? await gitRoot($, ['rm', '--cached', '-r', '-q', '.']) : await gitRoot($, ['reset', '-q'])
  if (!r.ok) setNotice($, 'error', 'Could not unstage all:\n' + lastLines(r.err, 4))
}

export function parseMessage(text) {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .split('\n')
  while (lines.length && !lines[0].trim()) lines.shift()
  const subject = (lines.shift() ?? '').trim().replace(/^["'`]|["'`]$/g, '')
  const body = lines.join('\n').trim()
  return { subject, body }
}

function fullMessage(d) {
  return d.body ? d.subject + '\n\n' + d.body : d.subject
}

async function generateCommitMessage($) {
  const stat = await gitRoot($, ['diff', '--cached', '--stat'])
  const diff = await gitRoot($, ['diff', '--cached', '--no-ext-diff'])
  const log = repo.isUnborn ? { out: '' } : await gitRoot($, ['log', '--format=%s', '-n', '10'])
  if (!stat.out.trim()) {
    setNotice($, 'info', 'Nothing is staged. Stage files first.')
    return
  }
  const LIMIT = 40000
  const body = diff.out.length > LIMIT ? diff.out.slice(0, LIMIT) + '\n[diff truncated]' : diff.out
  const r = await $.model.complete({
    model: MODEL,
    maxTokens: 600,
    timeoutMs: 90000,
    system:
      'You write git commit messages. Output only the message: one subject line in the imperative mood, at most 72 characters, ' +
      'then optionally a blank line and a short body of "- " bullet lines saying what changed and why. ' +
      'If the recent commits use a convention (such as Conventional Commits prefixes), follow it. No code fences, quotes or preamble.',
    prompt:
      'Branch: ' + repo.branch + '\n\nRecent commit subjects:\n' + (log.out.trim() || '(none)') +
      '\n\nStaged files:\n' + stat.out.trim() + '\n\nStaged diff:\n' + body,
  })
  if (!r.isAnswered || !r.text?.trim()) {
    setNotice($, 'error', 'The model did not write a message' + (r.reason ? ': ' + r.reason : '.') + ' Try Regenerate.')
    return
  }
  const msg = parseMessage(r.text)
  draft = { subject: msg.subject, body: msg.body, isEditing: false }
  notice = null
}

async function commitDraft($) {
  const message = fullMessage(draft).trim()
  if (!draft.subject.trim()) {
    setNotice($, 'error', 'The commit subject is empty. Edit the message first.')
    return
  }
  const r = await gitRoot($, ['commit', '-F', '-'], { stdin: message + '\n', timeoutMs: 60000 })
  if (!r.ok) {
    setNotice($, 'error', 'Commit failed:\n' + lastLines(r.err || r.out, 6))
    return
  }
  const head = await gitRoot($, ['rev-parse', '--short', 'HEAD'])
  draft = null
  setNotice($, 'ok', 'Committed ' + head.out.trim() + ': ' + message.split('\n')[0])
}

async function push($) {
  if (repo.isDetached) {
    setNotice($, 'error', 'HEAD is detached. Check out a branch before pushing.')
    return
  }
  let args = ['push']
  let target = repo.upstream
  if (!repo.upstream) {
    const remotes = (await gitRoot($, ['remote'])).out.split('\n').map((s) => s.trim()).filter(Boolean)
    if (!remotes.length) {
      setNotice($, 'error', 'No remote is configured. Add one with: git remote add origin <url>')
      return
    }
    const remote = remotes.includes('origin') ? 'origin' : remotes[0]
    args = ['push', '-u', remote, repo.branch]
    target = remote + '/' + repo.branch
  }
  const r = await gitRoot($, args, { timeoutMs: 180000 })
  if (!r.ok) {
    setNotice($, 'error', 'Push failed:\n' + lastLines(r.err || r.out, 6))
    return
  }
  setNotice($, 'ok', 'Pushed ' + repo.branch + ' → ' + target)
}

// Fast-forward only: never creates a merge commit or rewrites local commits
async function pull($) {
  if (repo.isDetached) {
    setNotice($, 'error', 'HEAD is detached. Check out a branch before pulling.')
    return
  }
  if (!repo.upstream) {
    setNotice($, 'error', repo.branch + ' has no upstream yet. Push it first, or run: git branch -u origin/' + repo.branch)
    return
  }
  const before = (await gitRoot($, ['rev-parse', 'HEAD'])).out.trim()
  const r = await gitRoot($, ['pull', '--ff-only'], { timeoutMs: 180000 })
  if (!r.ok) {
    const text = r.err || r.out
    const hint = /not possible to fast-forward|diverg/i.test(text)
      ? '\nThe branches have diverged. Run git pull --rebase or git pull --no-rebase yourself.'
      : ''
    setNotice($, 'error', 'Pull failed:\n' + lastLines(text, 6) + hint)
    return
  }
  const after = (await gitRoot($, ['rev-parse', 'HEAD'])).out.trim()
  if (before === after) {
    setNotice($, 'ok', repo.branch + ' is already up to date with ' + repo.upstream)
    return
  }
  const count = Number((await gitRoot($, ['rev-list', '--count', before + '..' + after])).out.trim()) || 0
  setNotice($, 'ok', 'Pulled ' + count + ' commit' + (count === 1 ? '' : 's') + ' from ' + repo.upstream + ' into ' + repo.branch)
}

export function cleanTitle(text) {
  const words = String(text ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)[0]
  if (!words) return ''
  return words
    .replace(/^["'`*]+|["'`*.]+$/g, '')
    .split(/\s+/)
    .slice(0, 6)
    .join(' ')
    .slice(0, 60)
}

function autoTitle(list) {
  const names = list.map((f) => f.path.split('/').pop())
  if (!names.length) return 'Work in progress'
  return names.length <= 2 ? 'Changes in ' + names.join(', ') : 'Changes in ' + names.slice(0, 2).join(', ') + ' +' + (names.length - 2)
}

async function stash($) {
  if (!files.length) {
    setNotice($, 'info', 'Nothing to stash: the working tree is clean.')
    return
  }
  if (repo.isUnborn) {
    setNotice($, 'error', 'Make a first commit before stashing.')
    return
  }
  const stat = await gitRoot($, ['diff', 'HEAD', '--stat'])
  const diff = await gitRoot($, ['diff', 'HEAD', '--no-ext-diff'])
  const untracked = files.filter((f) => f.isUntracked).map((f) => f.path)
  let title = ''
  try {
    const r = await $.model.complete({
      model: MODEL,
      maxTokens: 40,
      timeoutMs: 30000,
      system: 'Summarize these uncommitted changes as a stash title of at most 6 words. Output only the title: no quotes, no trailing period.',
      prompt:
        'Changed files:\n' + (stat.out.trim() || '(none)') + '\n\nNew files:\n' + (untracked.join('\n') || '(none)') +
        '\n\nDiff:\n' + diff.out.slice(0, 12000),
    })
    if (r.isAnswered) title = cleanTitle(r.text)
  } catch {
    // fall back to a title from the file names
  }
  if (!title) title = autoTitle(files)
  const r = await gitRoot($, ['stash', 'push', '-u', '-m', title], { timeoutMs: 60000 })
  if (!r.ok) {
    setNotice($, 'error', 'Stash failed:\n' + lastLines(r.err || r.out, 6))
    return
  }
  const hash = (await gitRoot($, ['rev-parse', 'stash@{0}'])).out.trim()
  draft = null
  stashesOpen = true
  setNotice($, 'ok', 'Stashed "' + title + '" as ' + hash.slice(0, 10), hash)
}

async function restore($, s) {
  // Find the stash by hash: its stash@{n} index shifts when others are added
  const sl = await gitRoot($, ['stash', 'list', '--format=%gd%x1f%h%x1f%gs%x1f%cr%x1e'])
  const current = parseStashes(sl.out).find((x) => x.hash === s.hash)
  if (!current) {
    setNotice($, 'error', 'That stash no longer exists.')
    return
  }
  const r = await gitRoot($, ['stash', 'apply', current.ref], { timeoutMs: 60000 })
  if (!r.ok) {
    setNotice($, 'error', 'Restore of "' + s.title + '" stopped:\n' + lastLines(r.err || r.out, 6))
    return
  }
  setNotice($, 'ok', 'Restored "' + s.title + '" (the stash is kept).')
}

async function drop($, s) {
  confirmDrop = ''
  const sl = await gitRoot($, ['stash', 'list', '--format=%gd%x1f%h%x1f%gs%x1f%cr%x1e'])
  const current = parseStashes(sl.out).find((x) => x.hash === s.hash)
  if (!current) {
    setNotice($, 'error', 'That stash no longer exists.')
    return
  }
  // Keep the full hash: `git stash store -m <title> <hash>` brings a dropped stash back
  const hash = (await gitRoot($, ['rev-parse', current.ref])).out.trim()
  const r = await gitRoot($, ['stash', 'drop', current.ref])
  if (!r.ok) {
    setNotice($, 'error', 'Remove of "' + s.title + '" failed:\n' + lastLines(r.err || r.out, 6))
    return
  }
  setNotice($, 'ok', 'Removed "' + s.title + '" (' + hash.slice(0, 10) + '). To undo: git stash store ' + hash.slice(0, 10), hash)
}

// ---------- drawing helpers (no $) ----------

function splitPath(p) {
  const i = p.lastIndexOf('/')
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)]
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'git', description: 'Open the git panel (changes, commit, pull, push, stashes)', immediate: true })
    } catch (err) {
      $.ui.log('git-mod: could not register /git: ' + err.message, { to: 'debug' })
    }
    $.clock.every(POLL_MS, () => {
      if (paneOpen && !busy) refresh($).catch(() => {})
    })
    // Always on: open the panel by itself when the session is in a git repo.
    // A pane the mod opens waits for a wide enough terminal (144+ columns).
    try {
      await refresh($)
      if (repo && !repo.error) {
        paneOpen = true
        await $.ui.open({ id: PANE, title: 'Git', columns: 56 })
      }
    } catch (err) {
      $.ui.log('git-mod: could not open the panel: ' + (err?.message ?? err), { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: 'git' }, async ($) => {
    paneOpen = true
    lastSig = ''
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Git', focus: true, closeOnEscape: true, columns: 56 })
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    return next(e)
  })

  // Claude may have changed files or run git: refresh after the tool ran
  on('tool.call', { tool: WATCHED_TOOLS }, async ($, e, next) => {
    const result = await next(e)
    if (paneOpen && !busy) refresh($).catch(() => {})
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (paneOpen && !busy) refresh($).catch(() => {})
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    paneOpen = true
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const cols = e.props.bodyColumns ?? 60
    const narrow = cols < 44
    const redraw = () => $.ui.invalidate('ui.render')
    const rule = () => Text({ dimColor: true, children: ['─'.repeat(Math.max(10, Math.min(cols, 200)))] })

    if (!loaded) {
      refresh($).catch(() => {})
      return Box({ flexDirection: 'column', children: [Text({ dimColor: true, children: ['Reading repository…'] })] })
    }

    if (!repo || repo.error) {
      return Box({
        flexDirection: 'column',
        children: [
          Text({ color: 'yellow', children: [repo?.error ?? 'No repository.'] }),
          Text({ dimColor: true, wrap: 'wrap', children: ['Start Claude Code inside a git repository, then press r.'] }),
          Button({ key: 'refresh', label: 'Refresh (r)', hotkey: 'r', onPress: () => runAction($, 'Refreshing', async () => {}) }),
        ],
      })
    }

    const out = []

    // --- branch header ---
    const branchName = repo.isDetached ? 'detached at ' + repo.oid.slice(0, 7) : repo.branch
    out.push(
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Text({ color: 'cyan', children: ['●'] }),
          Text({ bold: true, color: 'cyan', wrap: 'truncate-middle', children: [branchName] }),
        ],
      }),
    )
    const slash = repo.branch.lastIndexOf('/')
    if (slash > 0 && !repo.isDetached) {
      const group = repo.branch.slice(0, slash)
      out.push(
        Box({
          flexDirection: 'row',
          columnGap: 1,
          paddingLeft: 2,
          children: [
            Text({ color: 'black', backgroundColor: 'blue', children: [' ' + group + ' '] }),
            Text({ dimColor: true, children: ['↳ from'] }),
            Text({ color: 'blue', bold: true, wrap: 'truncate-middle', children: [parentOf.parent || 'unknown base'] }),
          ],
        }),
      )
    }
    if (!repo.isDetached) {
      const sync = repo.upstream
        ? [
            Text({ color: repo.ahead ? 'green' : undefined, dimColor: !repo.ahead, children: ['↑' + repo.ahead] }),
            Text({ color: repo.behind ? 'red' : undefined, dimColor: !repo.behind, children: ['↓' + repo.behind] }),
            Text({ dimColor: true, wrap: 'truncate-middle', children: [repo.upstream] }),
          ]
        : [Text({ color: 'yellow', dimColor: true, wrap: 'truncate-end', children: [repo.isUnborn ? 'no commits yet' : 'not pushed yet · push sets upstream'] })]
      out.push(Box({ flexDirection: 'row', columnGap: 1, paddingLeft: 2, children: sync }))
    }

    // --- action bar ---
    const staged = stagedFiles()
    const unstaged = unstagedFiles()
    out.push(
      Box({
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: 1,
        marginTop: 1,
        children: [
          Button({
            key: 'stash',
            label: 'Stash (s)',
            hotkey: 's',
            dimColor: !files.length,
            onPress: () => runAction($, 'Stashing (writing a title)', () => stash($)),
          }),
          Button({
            key: 'commit',
            label: 'Commit (c)',
            hotkey: 'c',
            dimColor: !staged.length,
            ...(staged.length && !draft ? { variant: 'primary' } : {}),
            onPress: () => {
              if (!staged.length) return setNotice($, 'info', 'Nothing is staged. Press Stage on the files to commit.')
              if (draft) return setNotice($, 'info', 'A message is already drafted below. Approve, edit or cancel it.')
              return runAction($, 'Writing commit message', () => generateCommitMessage($))
            },
          }),
          Button({
            key: 'pull',
            label: 'Pull (l)' + (repo.behind ? ' ↓' + repo.behind : ''),
            hotkey: 'l',
            dimColor: !repo.upstream,
            ...(repo.behind && !staged.length && !draft ? { variant: 'primary' } : {}),
            onPress: () => runAction($, 'Pulling', () => pull($)),
          }),
          Button({
            key: 'push',
            label: 'Push (p)' + (repo.ahead ? ' ↑' + repo.ahead : ''),
            hotkey: 'p',
            ...(repo.ahead && !repo.behind && !staged.length && !draft ? { variant: 'primary' } : {}),
            onPress: () => runAction($, 'Pushing', () => push($)),
          }),
          Button({ key: 'refresh', label: 'Refresh (r)', hotkey: 'r', onPress: () => runAction($, 'Refreshing', async () => {}) }),
        ],
      }),
    )

    if (busy) out.push(Text({ color: 'yellow', children: ['… ' + busy] }))

    // --- notice banner ---
    if (notice) {
      const color = notice.tone === 'ok' ? 'green' : notice.tone === 'error' ? 'red' : 'blue'
      const mark = notice.tone === 'ok' ? '✓ ' : notice.tone === 'error' ? '✕ ' : '● '
      out.push(
        Box({
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: color,
          paddingX: 1,
          marginTop: 1,
          children: [
            Text({ color, wrap: 'wrap', children: [mark + notice.text] }),
            Box({
              flexDirection: 'row',
              columnGap: 1,
              children: [
                ...(notice.hash
                  ? [Button({ key: 'copy-hash', label: 'Copy hash', plain: true, onPress: (p) => { $.ui.copy({ text: notice.hash, surface: p.surface }); $.ui.toast('Copied ' + notice.hash.slice(0, 10)) } })]
                  : []),
                Button({ key: 'dismiss', label: 'Dismiss', plain: true, dimColor: true, onPress: () => { notice = null; redraw() } }),
              ],
            }),
          ],
        }),
      )
    }

    // --- commit draft ---
    if (draft) {
      const d = draft
      const body = d.isEditing
        ? [
            Input({
              key: 'edit-subject',
              label: 'Subject ',
              value: d.subject,
              placeholder: 'Short imperative summary',
              submitLabel: 'save',
              autoFocus: true,
              onInput: (v) => { d.subject = v },
              onSubmit: (v) => { d.subject = v; redraw() },
            }),
            Input({
              key: 'edit-body',
              label: 'Body    ',
              value: d.body.split('\n').join(' | '),
              placeholder: 'Optional; separate lines with |',
              submitLabel: 'save',
              onInput: (v) => { d.body = v.split(/\s*\|\s*/).join('\n').trim() },
              onSubmit: (v) => { d.body = v.split(/\s*\|\s*/).join('\n').trim(); d.isEditing = false; redraw() },
            }),
          ]
        : [
            Text({ bold: true, wrap: 'wrap', children: [d.subject || '(empty subject)'] }),
            ...(d.body ? [Text({ dimColor: true, wrap: 'wrap', children: [d.body] })] : []),
          ]
      out.push(
        Box({
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: 'cyan',
          paddingX: 1,
          marginTop: 1,
          children: [
            Box({
              flexDirection: 'row',
              columnGap: 1,
              children: [
                Text({ color: 'cyan', bold: true, children: ['Commit message'] }),
                Text({ dimColor: true, children: ['· ' + staged.length + ' staged file' + (staged.length === 1 ? '' : 's')] }),
              ],
            }),
            ...body,
            Box({
              flexDirection: 'row',
              flexWrap: 'wrap',
              columnGap: 1,
              marginTop: 1,
              children: [
                Button({
                  key: 'approve',
                  label: 'Approve & commit (a)',
                  hotkey: 'a',
                  variant: 'primary',
                  onPress: () => runAction($, 'Committing', () => commitDraft($)),
                }),
                d.isEditing
                  ? Button({ key: 'edit-done', label: 'Done editing', onPress: () => { d.isEditing = false; redraw() } })
                  : Button({ key: 'edit', label: 'Edit (e)', hotkey: 'e', onPress: () => { d.isEditing = true; redraw() } }),
                Button({
                  key: 'regenerate',
                  label: 'Regenerate (g)',
                  hotkey: 'g',
                  onPress: () => runAction($, 'Writing commit message', () => generateCommitMessage($)),
                }),
                Button({ key: 'cancel', label: 'Cancel (x)', hotkey: 'x', dimColor: true, onPress: () => { draft = null; redraw() } }),
              ],
            }),
          ],
        }),
      )
    }

    // --- file lists ---
    const fileRow = (f, isStagedList) => {
      const code = isStagedList ? f.x : f.isUntracked ? '?' : f.isConflict ? 'U' : f.y
      const kind = KIND[kindOf(code)]
      const [dir, base] = splitPath(f.path)
      const shown = f.orig && isStagedList ? splitPath(f.orig)[1] + ' → ' : ''
      return Box({
        key: (isStagedList ? 'srow-' : 'urow-') + f.path,
        flexDirection: 'row',
        justifyContent: 'space-between',
        columnGap: 1,
        paddingLeft: 1,
        children: [
          Box({
            flexDirection: 'row',
            columnGap: 1,
            flexShrink: 1,
            flexGrow: 1,
            children: [
              Text({ color: kind.color, bold: true, children: [kind.glyph] }),
              Text({
                wrap: 'truncate-start',
                children: [
                  Text({ dimColor: true, children: [narrow ? '' : dir] }),
                  Text({ color: kind.color, children: [shown + base] }),
                  ...(f.isUntracked && !narrow ? [Text({ dimColor: true, children: [' new'] })] : []),
                ],
              }),
            ],
          }),
          isStagedList
            ? Button({ key: 'unstage-' + f.path, label: 'Unstage', dimColor: true, onPress: () => runAction($, 'Unstaging', () => unstageFile($, f)) })
            : Button({ key: 'stage-' + f.path, label: 'Stage', onPress: () => runAction($, 'Staging', () => stageFile($, f)) }),
        ],
      })
    }

    const section = (title, color, list, isStagedList) =>
      Box({
        flexDirection: 'column',
        marginTop: 1,
        children: [
          Box({
            flexDirection: 'row',
            justifyContent: 'space-between',
            children: [
              Box({
                flexDirection: 'row',
                columnGap: 1,
                children: [Text({ bold: true, color, children: [title] }), Text({ dimColor: true, children: ['(' + list.length + ')'] })],
              }),
              list.length
                ? isStagedList
                  ? Button({ key: 'unstage-all', label: 'Unstage all', plain: true, dimColor: true, onPress: () => runAction($, 'Unstaging all', () => unstageAll($)) })
                  : Button({ key: 'stage-all', label: 'Stage all', plain: true, dimColor: true, onPress: () => runAction($, 'Staging all', () => stageAll($)) })
                : Text({ children: [''] }),
            ],
          }),
          ...(list.length
            ? list.map((f) => fileRow(f, isStagedList))
            : [Text({ dimColor: true, children: [isStagedList ? '  Nothing staged' : '  No unstaged changes'] })]),
        ],
      })

    out.push(rule())
    if (!files.length) {
      out.push(Text({ color: 'green', children: ['✓ Working tree clean'] }))
    } else {
      out.push(section('STAGED', 'green', staged, true))
      out.push(section('CHANGES', 'yellow', unstaged, false))
    }

    // --- stashes ---
    out.push(rule())
    out.push(
      Button({
        key: 'toggle-stashes',
        label: (stashesOpen ? '▾ ' : '▸ ') + 'Stashes (' + stashes.length + ')',
        hotkey: 't',
        plain: true,
        onPress: () => { stashesOpen = !stashesOpen; redraw() },
      }),
    )
    if (stashesOpen) {
      if (!stashes.length) out.push(Text({ dimColor: true, children: ['  No stashes'] }))
      for (const s of stashes) {
        out.push(
          Box({
            key: 'stash-' + s.hash,
            flexDirection: 'column',
            paddingLeft: 2,
            marginTop: 1,
            children: [
              Box({
                flexDirection: 'row',
                justifyContent: 'space-between',
                columnGap: 1,
                children: [
                  Box({ flexShrink: 1, flexGrow: 1, children: [Text({ bold: true, color: 'magenta', wrap: 'wrap', children: [s.title || '(no title)'] })] }),
                  ...(confirmDrop === s.hash
                    ? [
                        Button({ key: 'confirm-drop-' + s.hash, label: 'Confirm remove', onPress: () => runAction($, 'Removing stash', () => drop($, s)) }),
                        Button({ key: 'keep-' + s.hash, label: 'Keep', dimColor: true, onPress: () => { confirmDrop = ''; redraw() } }),
                      ]
                    : [
                        Button({ key: 'restore-' + s.hash, label: 'Restore', onPress: () => runAction($, 'Restoring stash', () => restore($, s)) }),
                        Button({ key: 'drop-' + s.hash, label: 'Remove', dimColor: true, onPress: () => { confirmDrop = s.hash; redraw() } }),
                      ]),
                ],
              }),
              ...(narrow
                ? []
                : [Text({ dimColor: true, wrap: 'truncate-end', children: [s.ref + ' · ' + s.hash + ' · ' + s.when + (s.branch ? ' · ' + s.branch : '')] })]),
            ],
          }),
        )
      }
    }

    // --- legend ---
    if (!narrow) {
      out.push(rule())
      out.push(
        Box({
          flexDirection: 'row',
          flexWrap: 'wrap',
          columnGap: 2,
          children: ['added', 'modified', 'deleted', 'renamed', 'conflict'].map((k) =>
            Text({ children: [Text({ color: KIND[k].color, bold: true, children: [KIND[k].glyph + ' '] }), Text({ dimColor: true, children: [KIND[k].label] })] }),
          ),
        }),
      )
    }

    return Box({ flexDirection: 'column', children: out })
  })
}
