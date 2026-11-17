import { expect, test } from 'claude-code/testing'

const TOOL = 'mcp__irai-checklist__checklist'

const PANE = {
  plugin: 'irai-checklist',
  component: 'Pane',
  requestId: 'irai-checklist',
  props: {
    title: '依頼チェックリスト',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('未登録の依頼・未完了の依頼があると終了を一度止める', async ($, on) => {
  on('command.register', () => ({ value: { command: 'irai' } }))
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.Stop', () => ({}))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // 何も依頼が無ければ止めない
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()

  await $.prompt.submit({ text: 'フォルダを教科別に整理して、それとテストIDも印刷して' })
  const unregistered = await $.classic.Stop({ stop_hook_active: false })
  expect(unregistered.block).toContain('登録されていません')

  // 2回目（stop_hook_active）は止めない
  expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()

  const added = await $.tool.call({
    tool: TOOL,
    add: ['フォルダを教科別に整理', 'テストIDを印刷'],
  })
  expect(String(added.result)).toContain('R1 [未着手] フォルダを教科別に整理')
  expect(String(added.result)).toContain('R2 [未着手] テストIDを印刷')

  const open = await $.classic.Stop({ stop_hook_active: false })
  expect(open.block).toContain('R1')
  expect(open.block).toContain('R2')

  await $.tool.call({
    tool: TOOL,
    update: [
      { id: 'R1', status: 'done' },
      { id: 'R2', status: 'waiting', note: 'プリンターの指定待ち' },
    ],
  })
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /プリンターの指定待ち/ }))?.text).toContain(
      'プリンターの指定待ち',
    )
    await ui.press({ key: 'reopen-R1' })
    expect((await ui.find({ type: 'Text', text: /未完了 1/ }))?.text).toContain('未完了 1')
    await ui.press({ key: 'done-R1' })
    await ui.unmount()
  }

  const none = await $.prompt.submit({ text: 'ありがとう' })
  void none
  await $.tool.call({ tool: TOOL, none: true })
  expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
})
