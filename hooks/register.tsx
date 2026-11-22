import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cleanup, Lookup } from '../types'

// Panes an earlier version of this mod opened, closed when it loads.
const OLD_PANES = ['cleanup', 'lookup']
// Longer selections are cut to this in the menu row's label.
const LABEL_CHARS = 30

const lookup = atom(
  { plugin: 'd2d-claude-utility-mod', key: 'lookup' } as const,
  { word: '', status: 'idle', text: '', note: '' } as Lookup,
  { shape: 'lookup-2' },
)
const cleanup = atom(
  { plugin: 'd2d-claude-utility-mod', key: 'cleanup' } as const,
  { phase: 'idle', files: 0, kb: 0, message: '' } as Cleanup,
  { shape: 'cleanup-1' },
)

// macOS Dictionary Services, through JavaScript for Automation: the same
// definitions the Dictionary app and Look Up show.
const DICTIONARY = `ObjC.import("CoreServices");
function run(argv) {
  const word = $(argv[0]);
  const ref = $.DCSCopyTextDefinition($(), word, $.CFRangeMake(0, word.length));
  return ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || "";
}`

// Where the pointer is, in screen points from the top left, as "x,y".
const POINTER = `ObjC.import("AppKit");
function run() {
  const p = $.NSEvent.mouseLocation;
  const h = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
  return p.x + "," + (h - p.y);
}`

// Opens macOS's own Look Up popup on the word at x,y. The shortcut,
// Control-Command-D, looks up the word under the pointer, so once the menu
// has closed the pointer goes over the word for the key press, then back to
// where it was. Posting a key needs Accessibility permission; without it,
// says so.
const NATIVE_LOOKUP = `ObjC.import("AppKit"); ObjC.import("CoreGraphics"); ObjC.import("ApplicationServices");
function run(argv) {
  if (!$.AXIsProcessTrusted()) return "untrusted";
  delay(0.35);
  const was = $.NSEvent.mouseLocation;
  const height = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
  $.CGWarpMouseCursorPosition({ x: Number(argv[0]), y: Number(argv[1]) });
  delay(0.05);
  const flags = 0x40000 | 0x100000;
  const down = $.CGEventCreateKeyboardEvent($(), 2, true);
  const up = $.CGEventCreateKeyboardEvent($(), 2, false);
  $.CGEventSetFlags(down, flags);
  $.CGEventSetFlags(up, flags);
  $.CGEventPost(0, down);
  $.CGEventPost(0, up);
  delay(0.12);
  $.CGWarpMouseCursorPosition({ x: was.x, y: height - was.y });
  return "ok";
}`

const dirname = (path: string) => path.replace(/\/[^/]*\/?$/, '')
const basename = (path: string) => path.replace(/\/$/, '').replace(/^.*\//, '')

type Targets = { dirs: string[] }

// The folders that hold this session's throwaway files: the scratchpad, the
// background task output beside it, and the saved large tool outputs.
// Each is checked to sit under a folder named for this session's id.
const findTargets = async ($: EngineInterface): Promise<Targets> => {
  const info = await $.session.info()
  const env = await $.process.hookEnv()
  const id: string = env.CLAUDE_CODE_SESSION_ID ?? basename(info.transcriptPath).replace(/\.jsonl$/, '')
  const dirs: string[] = []
  if (id === '') return { dirs }

  if (info.scratchpadDir !== undefined) {
    const sessionTmp = dirname(info.scratchpadDir)
    if (basename(sessionTmp) === id) {
      dirs.push(info.scratchpadDir, `${sessionTmp}/tasks`)
    }
  }
  if (info.transcriptPath !== '') {
    dirs.push(`${dirname(info.transcriptPath)}/${id}/tool-results`)
  }

  const present: string[] = []
  for (const dir of dirs) {
    if (await $.fs.exists(dir)) present.push(dir)
  }

  return { dirs: present }
}

// ---- Cleanup: count first, then ask, then delete ------------------------

async function measure($: EngineInterface) {
  await update($, lookup, l => ({ ...l, status: 'idle' as const }))
  await update($, cleanup, c => ({ ...c, phase: 'measuring' as const, message: '' }))
  try {
    const { dirs } = await findTargets($)
    let files = 0
    let kb = 0
    for (const dir of dirs) {
      const found = await $.process.run(['find', dir, '-mindepth', '1', '-type', 'f'])
      files += found.stdout.split('\n').filter(Boolean).length
      const du = await $.process.run(['du', '-sk', dir])
      kb += Number.parseInt(du.stdout, 10) || 0
    }
    if (files === 0) {
      await reset($)
      $.ui.toast('Nothing to clean: this session has no temp files.')
      return
    }
    await update($, cleanup, () => ({ phase: 'confirm' as const, files, kb, message: '' }))
  } catch (error) {
    await update($, cleanup, c => ({ ...c, phase: 'error' as const, message: String(error) }))
  }
}

function sizeOf(kb: number) {
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`
}

async function remove($: EngineInterface) {
  const before = await read($, cleanup)
  await update($, cleanup, c => ({ ...c, phase: 'deleting' as const }))
  try {
    const { dirs } = await findTargets($)
    for (const dir of dirs) {
      // Empty each folder but keep it, so the session can keep writing there.
      for (const entry of await $.fs.list(dir)) {
        await $.process.run(['rm', '-rf', `${dir}/${entry.name}`])
      }
    }
    const done = `Deleted ${before.files} files (${sizeOf(before.kb)}). Ready to delete the session.`
    await reset($)
    $.ui.toast(done)
  } catch (error) {
    await update($, cleanup, c => ({ ...c, phase: 'error' as const, message: String(error) }))
  }
}

function reset($: EngineInterface) {
  return update($, cleanup, () => ({ phase: 'idle' as const, files: 0, kb: 0, message: '' }))
}


let pointer: { x: number; y: number; word: string } | undefined

// The in-row fallback: Dictionary Services' plain text for the word.
async function showDefinition($: EngineInterface, word: string, note: string) {
  await update($, lookup, () => ({ word, status: 'loading' as const, text: '', note }))
  const ran = await $.process
    .run(['osascript', '-l', 'JavaScript', '-e', DICTIONARY, word], { timeoutMs: 10000 })
    .catch(() => undefined)
  const text = ran?.exitCode === 0 ? ran.stdout.trim() : ''
  await update($, lookup, now =>
    now.word === word
      ? { ...now, status: text === '' ? ('missing' as const) : ('found' as const), text }
      : now,
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'cleanup',
      description: 'Check what the session cleanup would delete',
    })
    for (const id of OLD_PANES) void $.ui.close({ id }).catch(() => undefined)

    return started
  })

  on('command.run', { command: 'cleanup' }, async $ => {
    await measure($)
    const now = await read($, cleanup)

    return {
      text:
        now.phase === 'confirm'
          ? `Found ${now.files} temp files (${sizeOf(now.kb)}). Press Delete above the prompt to remove them.`
          : now.phase === 'error'
            ? `Cleanup failed: ${now.message}`
            : 'Nothing to clean: this session has no temp files.',
    }
  })

  // ---- Right-click menu: Look up and Search Google on a selection; the
  // session cleanup only where nothing is selected -----------------------

  on('ui.render', { component: 'ContextMenu' }, ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const cleanupRow = (
      <Button key="cleanup" onPress={() => measure($)}>
        Clean up session files… <Text dimColor>Asks before deleting</Text>
      </Button>
    )

    const selected = e.props.selection?.text.trim() ?? ''
    if (selected === '') return cleanupRow

    const oneLine = selected.replace(/\s+/g, ' ')
    // Cut at the last whole word that fits, or mid-word for one long word.
    const cut = oneLine.slice(0, LABEL_CHARS + 1)
    const atWord = cut.lastIndexOf(' ')
    const label =
      oneLine.length <= LABEL_CHARS
        ? oneLine
        : `${(atWord > 0 ? cut.slice(0, atWord) : cut.slice(0, LABEL_CHARS)).trimEnd()}…`
    const query = selected.slice(0, 1500)
    const google = `https://www.google.com/search?q=${encodeURIComponent(query)}`

    // Note where the pointer is as the menu opens: over the word just
    // right-clicked, which the native popup is opened on.
    {
      void $.process
        .run(['osascript', '-l', 'JavaScript', '-e', POINTER], { timeoutMs: 5000 })
        .then(ran => {
          const [x, y] = ran.stdout.trim().split(',').map(Number)
          if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
            pointer = { x, y, word: selected }
          }
        })
        .catch(() => undefined)
    }

    const lookUp = async () => {
      const at = pointer?.word === selected ? pointer : undefined
      if (at !== undefined) {
        const ran = await $.process
          .run(['osascript', '-l', 'JavaScript', '-e', NATIVE_LOOKUP, String(at.x), String(at.y)], {
            timeoutMs: 10000,
          })
          .catch(() => undefined)
        if (ran?.stdout.trim() === 'ok') return
      }
      const note =
        at === undefined
          ? 'Could not tell where the word was, so here is the definition instead.'
          : 'The macOS popup needs Accessibility permission for Claude (System Settings → Privacy & Security → Accessibility).'
      await showDefinition($, selected, note)
    }

    return (
      <Box flexDirection="column">
        <Button key="lookup" onPress={lookUp}>
          Look up "{label}" <Text dimColor>Dictionary meaning</Text>
        </Button>
        <Link href={google}>Search Google for "{label}"</Link>
      </Box>
    )
  })

  // ---- The row above the prompt: shown only while a lookup or a cleanup
  // the person asked for is open, and empty otherwise --------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const word = await read($, lookup)

    if (word.status !== 'idle') {
      const openDictionary = () =>
        void $.process.run(['open', `dict://${encodeURIComponent(word.word)}`])
      const close = () => update($, lookup, l => ({ ...l, status: 'idle' as const }))
      const body =
        word.status === 'loading'
          ? 'Looking it up…'
          : word.status === 'missing'
            ? 'No dictionary entry for this.'
            : word.text

      return (
        <Box flexDirection="column">
          {word.note !== '' && <Text dimColor>{word.note}</Text>}
          <Text wrap="wrap">
            <Text bold>📖 {word.word}</Text> <Text dimColor={word.status !== 'found'}>{body}</Text>
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="open-dictionary" onPress={openDictionary}>
              Open in Dictionary
            </Button>
            <Button key="close-lookup" onPress={close}>
              Close
            </Button>
          </Box>
        </Box>
      )
    }

    const now = await read($, cleanup)

    if (now.phase === 'confirm') {
      return (
        <Box flexDirection="row" gap={1}>
          <Text>
            Delete {now.files} temp files ({sizeOf(now.kb)})?
          </Text>
          <Button key="delete" variant="primary" onPress={() => remove($)}>
            Delete
          </Button>
          <Button key="cancel" onPress={() => reset($)}>
            Cancel
          </Button>
        </Box>
      )
    }

    if (now.phase === 'measuring' || now.phase === 'deleting') {
      return <Text dimColor>{now.phase === 'measuring' ? 'Checking temp files…' : 'Deleting…'}</Text>
    }

    if (now.phase === 'error') {
      return (
        <Box flexDirection="row" gap={1}>
          <Text dimColor>Cleanup failed: {now.message}</Text>
          <Button key="dismiss" onPress={() => reset($)}>
            Dismiss
          </Button>
        </Box>
      )
    }

    return next(e)
  })
}
