// 运行期共享引用：把这些实例挂在一个对象上，避免主文件里到处是全局变量，
// 也让拆出去的模块不用层层传参。
export interface AppCtx {
  ui: any
  sidebar: any
  editor: any
  browser: any
  terminals: Map<string, any>
  aiPanel: any
  sync: () => void
  openFile: (path: string, name?: string) => Promise<void>
  remotePanels: Map<string, any>
  openTerminal: (profile: any) => void
  openRemote: (profile: any) => void
}

export const ctx: AppCtx = {
  ui: null,
  sidebar: null,
  editor: null,
  browser: null,
  terminals: new Map(),
  aiPanel: null,
  sync: () => {},
  openFile: async () => {},
  remotePanels: new Map(),
  openTerminal: () => {},
  openRemote: () => {}
}
