export type IraiStatus = 'todo' | 'doing' | 'waiting' | 'done' | 'dropped'

export type IraiItem = {
  id: string
  text: string
  status: IraiStatus
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'irai-checklist': {
      items: Shaped<IraiItem[]>
      nextId: number
      isAwaiting: boolean
    }
  }
}
