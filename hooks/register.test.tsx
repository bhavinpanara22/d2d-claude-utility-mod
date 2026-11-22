import { expect, test } from 'claude-code/testing'

const MENU = { plugin: 'd2d-claude-utility-mod', surface: 'desktop', component: 'ContextMenu' } as const

const BAND = {
  plugin: 'd2d-claude-utility-mod',
  surface: 'desktop',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

test('a selected word gets Look up and Search Google', async $ => {
  const ui = await $.ui.mount({ ...MENU, props: { selection: { text: 'serendipity' } } })

  expect(await ui.find({ type: 'Button', key: 'lookup' })).toBeDefined()
  const link = await ui.find({ type: 'Link' })
  expect(link?.props.href).toBe('https://www.google.com/search?q=serendipity')
  expect(await ui.find({ type: 'Button', key: 'cleanup' })).toBeUndefined()
  await ui.unmount()
})

test('a long selection still gets Look up, its label cut short', async $ => {
  const text = 'one two three four five six seven eight\nnine ten eleven twelve'
  const ui = await $.ui.mount({ ...MENU, props: { selection: { text } } })

  const button = await ui.find({ type: 'Button', key: 'lookup' })
  expect(button?.text).toContain('Look up "one two three four five six…"')
  const link = await ui.find({ type: 'Link' })
  expect(link?.text).toContain('Search Google for "one two three four five six…"')
  await ui.unmount()
})

test('without a selection the menu has only the cleanup row', async $ => {
  const ui = await $.ui.mount({ ...MENU, props: { link: { href: 'https://example.com' } } })

  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'lookup' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'cleanup' })).toBeDefined()
  await ui.unmount()
})

test('nothing shows above the prompt until asked', async $ => {
  const ui = await $.ui.mount(BAND)

  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

const run = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

// Tells the three scripts apart by what they call.
const script = (argv: readonly string[]) => {
  const source = argv[4] ?? ''
  if (source.includes('CGEventPost')) return 'native'
  if (source.includes('mouseLocation')) return 'pointer'
  if (source.includes('DCSCopyTextDefinition')) return 'dictionary'
  return 'other'
}

test('Look up opens the macOS popup where the word was', async ($, on) => {
  const native: string[][] = []
  on('process.run', (_, e) => {
    const kind = script(e.argv)
    if (kind === 'native') native.push(e.argv.slice(5))
    return run(kind === 'pointer' ? '640,300' : kind === 'native' ? 'ok' : 'serendipity | noun luck')
  })

  const menu = await $.ui.mount({ ...MENU, props: { selection: { text: 'serendipity' } } })
  await menu.press({ key: 'lookup' })
  await menu.unmount()

  expect(native).toEqual([['640', '300']])
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /noun luck/ })).toBeUndefined()
  await band.unmount()
})

test('without Accessibility, Look up shows the definition above the prompt', async ($, on) => {
  on('process.run', (_, e) => {
    const kind = script(e.argv)
    return run(kind === 'pointer' ? '640,300' : kind === 'native' ? 'untrusted' : 'serendipity | noun luck')
  })

  const menu = await $.ui.mount({ ...MENU, props: { selection: { text: 'serendipity' } } })
  await menu.press({ key: 'lookup' })
  await menu.unmount()

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /noun luck/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Accessibility/ })).toBeDefined()
  await ui.press({ key: 'close-lookup' })
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('cleanup asks first, then empties the session folders', async ($, on) => {
  const removed: string[] = []
  on('session.info', () => ({
    value: {
      transcriptPath: '/home/p/abc.jsonl',
      scratchpadDir: '/tmp/x/abc/scratchpad',
    },
  }))
  on('process.hookEnv', () => ({ value: { CLAUDE_CODE_SESSION_ID: 'abc' } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [{ name: 'a.txt', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'rm') removed.push(e.argv[2] ?? '')
    const stdout = e.argv[0] === 'find' ? 'f1\n' : e.argv[0] === 'du' ? '8\t/x\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  const menu = await $.ui.mount({ ...MENU, props: {} })
  await menu.press({ key: 'cleanup' })
  await menu.unmount()

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /Delete 3 temp files/ }))?.text).toBe('Delete 3 temp files (24 KB)?')
  expect(removed).toEqual([])

  await ui.press({ key: 'delete' })
  expect(removed).toEqual([
    '/tmp/x/abc/scratchpad/a.txt',
    '/tmp/x/abc/tasks/a.txt',
    '/home/p/abc/tool-results/a.txt',
  ])
  expect(toasts).toEqual(['Deleted 3 files (24 KB). Ready to delete the session.'])
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})
