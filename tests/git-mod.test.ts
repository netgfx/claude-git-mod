import { expect, test } from 'claude-code/testing'
import { parseStatus, parseStashes, parseMessage, cleanTitle } from '../hooks/register.js'

const PANE = {
  plugin: 'git-mod',
  component: 'Pane',
  requestId: 'git-mod',
  viewport: { columns: 160, rows: 40 },
  props: { title: 'Git', isFocused: true, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const STATUS = [
  '# branch.oid 1111111111111111111111111111111111111111',
  '# branch.head feature/login-form',
  '# branch.upstream origin/feature/login-form',
  '# branch.ab +2 -0',
  '1 M. N... 100644 100644 100644 aaa bbb src/app.ts',
  '1 .D N... 100644 100644 000000 aaa aaa old.txt',
  '2 R. N... 100644 100644 100644 aaa bbb R100 docs/new name.md',
  'docs/old.md',
  '? notes/todo.md',
  '',
].join('\0')

const STASHES = 'stash@{0}\x1fabc1234\x1fOn feature/login-form: Tweak login form layout\x1f2 hours ago\x1e\n'

// A fake git: answers by subcommand and records every argv
function fakeGit(calls: string[][], overrides: Record<string, any> = {}) {
  return ($: any, e: any) => {
    const argv: string[] = [...e.argv]
    calls.push(argv)
    const args = argv.slice(5) // drop: git -c core.quotepath=false -c color.ui=false
    const sub = args[0]
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (overrides[sub]) return overrides[sub](args, e)
    if (sub === 'rev-parse' && args[1] === '--show-toplevel') return ok('C:/work\n')
    if (sub === 'rev-parse') return ok('deadbeefcafe1234\n')
    if (sub === 'status') return ok(STATUS)
    if (sub === 'stash' && args[1] === 'list') return ok(STASHES)
    if (sub === 'for-each-ref') return ok('develop\nmain\nfeature/login-form\norigin/develop\n')
    if (sub === 'reflog' && args.includes('HEAD')) return ok('commit: x\ncheckout: moving from develop to feature/login-form\n')
    if (sub === 'reflog') return ok('commit: y\nbranch: Created from HEAD\n')
    if (sub === 'diff') return ok(args.includes('--stat') ? ' src/app.ts | 2 +-\n' : '-a\n+b\n')
    if (sub === 'log') return ok('feat: add login\nfix: typo\n')
    return ok('')
  }
}

function baseStubs(on: any, calls: string[][], overrides: Record<string, any> = {}) {
  on('process.run', fakeGit(calls, overrides))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.copy', () => ({ value: undefined }))
}

test('parses porcelain v2 status, renames and untracked files', async () => {
  const { info, list } = parseStatus(STATUS)
  expect(info).toEqual({ branch: 'feature/login-form', oid: '1111111111111111111111111111111111111111', upstream: 'origin/feature/login-form', ahead: 2, behind: 0 })
  expect(list.map((f: any) => f.path)).toEqual(['src/app.ts', 'old.txt', 'docs/new name.md', 'notes/todo.md'])
  expect(list[2].orig).toBe('docs/old.md')
  expect(list[3].isUntracked).toBe(true)
})

test('parses stash titles and helper text', async () => {
  expect(parseStashes(STASHES)[0]).toEqual({ ref: 'stash@{0}', hash: 'abc1234', title: 'Tweak login form layout', branch: 'feature/login-form', when: '2 hours ago' })
  expect(cleanTitle('"Refactor the git panel layout and colors today."\nextra')).toBe('Refactor the git panel layout and')
  expect(parseMessage('```\nfeat: add x\n\n- one\n- two\n```')).toEqual({ subject: 'feat: add x', body: '- one\n- two' })
})

for (const surface of ['terminal', 'desktop'] as const) {
  test('panel shows branch, parent, files and stashes on ' + surface, async ($, on) => {
    const calls: string[][] = []
    baseStubs(on, calls)
    await $.command.run({ command: 'git', args: '' })
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    expect(await ui.find({ type: 'Text', text: 'feature/login-form' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'develop' })).toBeDefined() // parent from HEAD reflog
    expect(await ui.find({ type: 'Text', text: 'Tweak login form layout' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'stage-notes/todo.md' } as any)).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'unstage-src/app.ts' } as any)).toBeDefined()
    await ui.unmount()
  })
}

test('main shows no parent line', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls, {
    status: () => ({ value: { exitCode: 0, stdout: '# branch.oid 1\0# branch.head main\0', stderr: '' } }),
  })
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: 'main' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '↳ from' })).toBeUndefined()
  expect(calls.some((c) => c.includes('reflog'))).toBe(false)
})

test('Stage runs git add for that file', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'stage-notes/todo.md' })
  expect(calls.some((c) => c.slice(5).join(' ') === 'add -A -- notes/todo.md')).toBe(true)
})

test('Commit drafts a message with the model, Approve commits it', async ($, on) => {
  const calls: string[][] = []
  const stdins: string[] = []
  baseStubs(on, calls, {
    commit: (args: string[], e: any) => {
      stdins.push(e.init.stdin)
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    },
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: 'feat: add login form\n\n- validate inputs', usage: USAGE } }))
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'commit' })
  expect(await ui.find({ type: 'Text', text: 'feat: add login form' })).toBeDefined()
  await ui.press({ key: 'approve' })
  expect(stdins[0]).toBe('feat: add login form\n\n- validate inputs\n')
  expect(await ui.find({ type: 'Text', text: /Committed deadbee/ })).toBeDefined()
})

test('Stash uses a model title, includes untracked files and shows the hash', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls)
  on('model.complete', () => ({ value: { isAnswered: true, text: 'Login form validation work', usage: USAGE } }))
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'stash' })
  expect(calls.some((c) => c.slice(5).join(' ') === 'stash push -u -m Login form validation work')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Stashed "Login form validation work" as deadbeefca/ })).toBeDefined()
})

test('Restore applies the stash and keeps it', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls)
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'restore-abc1234' })
  expect(calls.some((c) => c.slice(5).join(' ') === 'stash apply stash@{0}')).toBe(true)
  expect(calls.some((c) => c.slice(5).includes('pop') || c.slice(5).includes('drop'))).toBe(false)
})

test('Push without upstream sets it on origin', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls, {
    status: () => ({ value: { exitCode: 0, stdout: '# branch.oid 1\0# branch.head fix/crash\0', stderr: '' } }),
    remote: () => ({ value: { exitCode: 0, stdout: 'upstream\norigin\n', stderr: '' } }),
  })
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'push' })
  expect(calls.some((c) => c.slice(5).join(' ') === 'push -u origin fix/crash')).toBe(true)
})

test('outside a repository the panel says so', async ($, on) => {
  const calls: string[][] = []
  baseStubs(on, calls, {
    'rev-parse': () => ({ value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } }),
  })
  await $.command.run({ command: 'git', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: 'Not inside a git repository.' })).toBeDefined()
})

test('session start opens the panel by itself inside a repo', async ($, on) => {
  const calls: string[][] = []
  const opened: any[] = []
  on('process.run', fakeGit(calls))
  on('ui.open', ($, e) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: 'C:\work' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\work' } as any)
  expect(opened.length).toBe(1)
  expect(opened[0].id).toBe('git-mod')
  expect(opened[0].focus).toBeUndefined()
})

test('session start leaves the panel closed outside a repo', async ($, on) => {
  const calls: string[][] = []
  const opened: any[] = []
  on('process.run', fakeGit(calls, { 'rev-parse': () => ({ value: { exitCode: 128, stdout: '', stderr: 'fatal' } }) }))
  on('ui.open', ($, e) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: 'C:\work' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\work' } as any)
  expect(opened.length).toBe(0)
})
