import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { IraiItem, IraiStatus } from '../types'

const PANE = 'irai-checklist'
const TITLE = '依頼チェックリスト'
const TOOL = 'mcp__irai-checklist__checklist'

const items = atom({ plugin: 'irai-checklist', key: 'items' } as const, [], {
  shape: 'items-1',
})
const nextId = atom({ plugin: 'irai-checklist', key: 'nextId' } as const, 1)
// A person's prompt arrived and the model has not yet touched the checklist.
const isAwaiting = atom(
  { plugin: 'irai-checklist', key: 'isAwaiting' } as const,
  false,
)

const STATUSES: readonly IraiStatus[] = ['todo', 'doing', 'waiting', 'done', 'dropped']
const LABEL: Record<IraiStatus, string> = {
  todo: '未着手',
  doing: '対応中',
  waiting: '確認待ち',
  done: '完了',
  dropped: '取り下げ',
}
const MARK: Record<IraiStatus, string> = {
  todo: '☐',
  doing: '▶',
  waiting: '?',
  done: '✔',
  dropped: '-',
}
const COLOR: Record<IraiStatus, 'warning' | 'suggestion' | 'permission' | 'success' | 'inactive'> = {
  todo: 'warning',
  doing: 'suggestion',
  waiting: 'permission',
  done: 'success',
  dropped: 'inactive',
}

const isOpen = (item: IraiItem) => item.status === 'todo' || item.status === 'doing'

const GUIDE = [
  '# 依頼チェックリスト',
  `このセッションには依頼チェックリスト（ツール ${TOOL}）があり、ユーザーにはチャットの横に表示されている。`,
  '- ユーザーのメッセージを受け取ったら、作業を始める前にこのツールを呼ぶ。メッセージに含まれる依頼を1件ずつ `add` で登録する（まとめて頼まれたものは分け、短い一文にする）。依頼の無い雑談・お礼・単なる返事なら `none: true` で呼ぶ。',
  '- 進み具合に合わせて `update` で状態を変える：doing（対応中）、done（完了）、waiting（ユーザーの返事や操作待ち。note に何を待っているか書く）、dropped（取り下げ・不要。note に理由）。',
  '- 「No response requested.」のように依頼を黙って流すことは絶対にしない。',
  '- 未着手(todo)・対応中(doing)が残ったままターンを終えない。終える前に対応するか、waiting/dropped にして理由を note とユーザーへの返答に書く。',
].join('\n')

function summary(list: readonly IraiItem[]): string {
  if (list.length === 0) {
    return 'チェックリストは空です。'
  }

  return list
    .map(i => `${i.id} [${LABEL[i.status]}] ${i.text}${i.note ? `（${i.note}）` : ''}`)
    .join('\n')
}

function asStatus(value: unknown): IraiStatus | undefined {
  return STATUSES.find(s => s === value)
}

async function refreshStatus($: EngineInterface) {
  const list = await read($, items)
  const open = list.filter(isOpen).length
  const waiting = list.filter(i => i.status === 'waiting').length
  $.ui.status(
    list.length === 0
      ? undefined
      : `依頼 未完了${open}件${waiting > 0 ? `・確認待ち${waiting}件` : ''}`,
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'irai',
      description: '依頼チェックリストのパネルを開く',
    })
    await $.tool.register({
      name: 'checklist',
      description:
        'このセッションの依頼チェックリストを更新する。add: 新しい依頼の文の配列。update: {id, status, note?} の配列（status は todo/doing/waiting/done/dropped）。none: 依頼の無いメッセージだったとき true。結果として現在のチェックリスト全体が返る。',
      inputSchema: {
        type: 'object',
        properties: {
          add: { type: 'array', items: { type: 'string' } },
          update: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                status: { type: 'string', enum: [...STATUSES] },
                note: { type: 'string' },
              },
              required: ['id', 'status'],
            },
          },
          none: { type: 'boolean' },
        },
      },
    })
    void $.ui.open({ id: PANE, title: TITLE })
    await refreshStatus($)

    return next(e)
  })

  on('command.run', { command: 'irai' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    const list = await read($, items)

    return { text: `依頼チェックリストを開きました。\n${summary(list)}` }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return {
      sections: [
        ...composed.sections,
        { id: 'irai-checklist:guide', text: GUIDE, scope: 'session' as const },
      ],
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta && e.command === undefined && e.text.trim() !== '') {
      await update($, isAwaiting, () => true)
    }

    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const adds = Array.isArray(input.add)
      ? input.add.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      : []
    const updates = Array.isArray(input.update) ? input.update : []
    const problems: string[] = []

    let first = await read($, nextId)
    await update($, nextId, n => {
      first = n
      return n + adds.length
    })
    const added: IraiItem[] = adds.map((text, k) => ({
      id: `R${first + k}`,
      text: text.trim(),
      status: 'todo',
    }))

    await update($, items, list => {
      const changed = list.map(item => {
        const change = updates.find(
          (u): u is Record<string, unknown> =>
            typeof u === 'object' && u !== null && (u as Record<string, unknown>).id === item.id,
        )
        if (!change) {
          return item
        }
        const status = asStatus(change.status)
        if (!status) {
          return item
        }
        const note = typeof change.note === 'string' && change.note.trim() !== ''
          ? change.note.trim()
          : item.note
        return { ...item, status, note }
      })
      return [...changed, ...added]
    })

    const list = await read($, items)
    for (const u of updates) {
      const change = (typeof u === 'object' && u !== null ? u : {}) as Record<string, unknown>
      if (!list.some(i => i.id === change.id)) {
        problems.push(`ID ${String(change.id)} は見つかりません`)
      } else if (!asStatus(change.status)) {
        problems.push(`ID ${String(change.id)} の status「${String(change.status)}」は使えません`)
      }
    }

    await update($, isAwaiting, () => false)
    await refreshStatus($)

    const head = problems.length > 0 ? `注意: ${problems.join('、')}\n` : ''
    return { result: `${head}現在の依頼チェックリスト:\n${summary(list)}` }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'チェックリストの更新に失敗しました。もう一度呼んでください。' },
  )

  // Before the main loop ends a turn: hold it once if the person's message was
  // never registered, or if requests are still not started or in progress.
  on('classic.Stop', async ($, e, next) => {
    const settled = await next(e)
    if (e.stop_hook_active || settled.block !== undefined) {
      return settled
    }

    if (await read($, isAwaiting)) {
      return {
        ...settled,
        block: `ユーザーの最新メッセージがまだ依頼チェックリストに登録されていません。${TOOL} を呼んで依頼を add するか、依頼が無ければ none: true で呼んでから終えてください。`,
      }
    }

    const open = (await read($, items)).filter(isOpen)
    if (open.length === 0) {
      return settled
    }

    return {
      ...settled,
      block: [
        '依頼チェックリストに未完了の項目が残っています：',
        ...open.map(i => `${i.id} [${LABEL[i.status]}] ${i.text}`),
        '今対応するか、ユーザーの返事待ちなら waiting、不要なら dropped にして（note に理由）、ユーザーへの返答でも触れてから終えてください。',
      ].join('\n'),
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, items)
    const open = list.filter(isOpen).length
    const waiting = list.filter(i => i.status === 'waiting').length
    const done = list.filter(i => i.status === 'done').length
    const isWidget = e.props.placement === 'widget'

    if (isWidget) {
      return (
        <Box flexDirection="column">
          <Text bold>依頼</Text>
          <Text color={open > 0 ? 'warning' : 'success'}>未完了 {open}</Text>
          {waiting > 0 && <Text color="permission">確認待ち {waiting}</Text>}
          <Text dimColor>完了 {done}</Text>
        </Box>
      )
    }

    const setStatus = (id: string, status: IraiStatus) =>
      update($, items, all => all.map(i => (i.id === id ? { ...i, status } : i))).then(() =>
        refreshStatus($),
      )
    const clearFinished = () =>
      update($, items, all => all.filter(i => i.status !== 'done' && i.status !== 'dropped')).then(
        () => refreshStatus($),
      )

    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          <Text color={open > 0 ? 'warning' : 'success'} bold>
            未完了 {open}
          </Text>
          <Text dimColor>
            {'  '}確認待ち {waiting}・完了 {done}
          </Text>
        </Text>
        {list.length === 0 && (
          <Text dimColor>まだ依頼はありません。話しかけると、ここに依頼が並びます。</Text>
        )}
        {list.map(item => (
          <Box key={`row-${item.id}`} flexDirection="column">
            <Text>
              <Text color={COLOR[item.status]} bold>
                {MARK[item.status]} {LABEL[item.status]}
              </Text>
              <Text dimColor> {item.id} </Text>
              <Text dimColor={item.status === 'done' || item.status === 'dropped'}>{item.text}</Text>
            </Text>
            {item.note && <Text dimColor>  └ {item.note}</Text>}
            {isOpen(item) || item.status === 'waiting' ? (
              <Box gap={1}>
                <Button
                  key={`done-${item.id}`}
                  label="完了にする"
                  onPress={() => setStatus(item.id, 'done')}
                />
                <Button
                  key={`drop-${item.id}`}
                  label="取り下げ"
                  onPress={() => setStatus(item.id, 'dropped')}
                />
              </Box>
            ) : (
              <Box>
                <Button
                  key={`reopen-${item.id}`}
                  label="戻す"
                  onPress={() => setStatus(item.id, 'todo')}
                />
              </Box>
            )}
          </Box>
        ))}
        {done + list.filter(i => i.status === 'dropped').length > 0 && (
          <Button key="clear" label="完了・取り下げを片付ける" onPress={clearFinished} />
        )}
      </Box>
    )
  })
}
