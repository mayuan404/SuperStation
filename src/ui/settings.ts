import { el, clear } from '../lib/dom'
import { invoke } from '../lib/bridge'
import * as S from '../lib/store'
import { openSheet, openPalette, toast, prompt, type PaletteItem } from './overlays'
import { THEMES, ICON_SETS, applyTheme } from './theme'
import { ctx } from '../lib/ctx'

export function themePalette(): void {
  const items: PaletteItem[] = THEMES.map((t) => ({
    id: t.id,
    label: t.name,
    sub: t.dark ? '深色' : '浅色',
    icon: t.dark ? 'moon' : 'sun',
    run: () => {
      S.state.settings.theme = t.id
      applyTheme(t.id, S.state.settings.iconSet)
      S.saveSettings()
      ctx.editor?.applySettings()
      S.emit('active')
      toast(`主题：${t.name}`, 1200)
    }
  }))
  openPalette({ placeholder: '选择主题…', items, emptyText: '没有找到主题' })
}

export function openShortcuts(): void {
  openSheet('快捷键', (body, close) => {
    const list: [string, string][] = [
      ['⌘O', '添加文件夹'],
      ['⌘P', '快速打开文件'],
      ['⌘⇧F', '全局搜索（文件名 + 内容）'],
      ['⌘F', '在当前文档内搜索'],
      ['⌘K', '命令面板'],
      ['⌘S / ⇧⌘S', '保存 / 另存为'],
      ['⌘W / ⇧⌘W', '关闭标签页 / 关闭窗口'],
      ['⌘E', '切换 编辑 / 对比 / 预览'],
      ['⌘B', '显示 / 隐藏侧边栏'],
      ['⌘N', '新建临时文件'],
      ['⌘⇧A', '打开 / 关闭 AI 助手'],
      ['⌘,', '设置'],
      ['⌘+ / ⌘- / ⌘0', '放大 / 缩小 / 重置字号'],
      ['⌃⌘F', '进入全屏'],
      ['⌘C / ⌘X / ⌘V', '文件树内 复制 / 剪切 / 粘贴'],
      ['⌘⇧B', '打开 / 关闭文件浏览'],
      ['⌘\\', '文件浏览：单栏 / 双栏'],
      ['⌥⌘N', '全局呼出 / 隐藏窗口（任何应用下都可用）']
    ]
    for (const [key, label] of list) {
      body.append(el('div', { class: 'sheet-row' },
        el('div', { class: 'lbl' }, label),
        el('kbd', { class: 'key' }, key)))
    }
    const done = el('button', { class: 'primary' }, '完成')
    done.addEventListener('click', () => close())
    body.append(el('div', { class: 'sheet-actions' }, done))
  }, 470)
}

export function openSettings(): void {
  openSheet('设置', (body, close) => {
    const s = S.state.settings
    const row = (label: string, hint: string, control: HTMLElement) => {
      const left = el('div', {}, el('div', { class: 'lbl' }, label), hint ? el('div', { class: 'hint' }, hint) : null)
      body.append(el('div', { class: 'sheet-row' }, left, control))
    }

    const themeBtn = el('button', { class: 'ghost' }, THEMES.find((t) => t.id === s.theme)?.name ?? s.theme)
    themeBtn.addEventListener('click', () => { close(); themePalette() })
    row('外观主题', '九套主题随时切换', themeBtn)

    const iconBtn = el('button', { class: 'ghost' }, ICON_SETS.find((i) => i.id === s.iconSet)?.name ?? '跟随主题')
    iconBtn.addEventListener('click', () => {
      close()
      openPalette({
        placeholder: '选择图标配色…',
        items: ICON_SETS.map((i) => ({
          id: i.id, label: i.name, sub: i.hint, icon: 'file',
          run: () => {
            s.iconSet = i.id
            S.saveSettings()
            applyTheme(s.theme, i.id)
            ctx.editor?.applySettings()
            S.emit('active')
            toast(`图标：${i.name}`, 1200)
          }
        }))
      })
    })
    row('文件图标', '独立于主题的图标配色', iconBtn)

    const range = el('input', { type: 'range', min: '10', max: '22', step: '1', value: String(s.fontSize) })
    const val = el('span', { class: 'val' }, `${s.fontSize}px`)
    const rangeWrap = el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, range, val)
    range.addEventListener('input', () => {
      s.fontSize = Number(range.value)
      val.textContent = `${s.fontSize}px`
      ctx.ui?.editorHost.style.setProperty('--editor-font-size', `${s.fontSize}px`)
      S.saveSettings()
    })
    row('编辑字号', '', rangeWrap)

    const mkToggle = (key: 'lineWrap' | 'autoSave' | 'showHidden', onChange?: () => void) => {
      const cb = el('input', { type: 'checkbox' })
      cb.checked = !!s[key]
      cb.addEventListener('change', () => {
        ;(s as any)[key] = cb.checked
        S.saveSettings()
        onChange?.()
      })
      return cb
    }

    row('自动换行', '长行在编辑器中折行显示', mkToggle('lineWrap', () => ctx.editor?.setWrap(s.lineWrap)))
    row('自动保存', '停止输入后自动写回磁盘', mkToggle('autoSave'))
    row('显示隐藏文件', '在文件树中显示以 . 开头的文件', mkToggle('showHidden', () => ctx.sidebar?.refresh()))

    body.append(el('div', { class: 'sheet-section' }, 'AI 助手'))
    const aiUrlBtn = el('button', { class: 'ghost' }, s.aiBaseUrl || 'https://api.deepseek.com')
    aiUrlBtn.addEventListener('click', async () => {
      const v = await prompt({ title: 'API 地址', label: '兼容 OpenAI 格式的接口地址', value: s.aiBaseUrl })
      if (v) { s.aiBaseUrl = v.trim(); S.saveSettings(); aiUrlBtn.textContent = s.aiBaseUrl }
    })
    row('API 地址', '默认 DeepSeek，也可填其他兼容服务', aiUrlBtn)

    const aiModelBtn = el('button', { class: 'ghost' }, s.aiModel || 'deepseek-flash')
    aiModelBtn.addEventListener('click', () => {
      openPalette({
        placeholder: '选择模型…',
        items: [
          { id: 'deepseek-flash', label: 'deepseek-flash', sub: '默认 · 快且便宜', icon: 'sparkles',
            run: () => pickModel('deepseek-flash') },
          { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro', sub: '更强，适合长文推理', icon: 'sparkles',
            run: () => pickModel('deepseek-v4-pro') },
          { id: 'custom', label: '自定义…', sub: '填其他兼容服务商的模型名', icon: 'pencil',
            run: async () => {
              const v = await prompt({ title: '模型', label: '模型名称', value: s.aiModel })
              if (v) pickModel(v.trim())
            } }
        ]
      })
    })
    const pickModel = (m: string) => {
      s.aiModel = m
      S.saveSettings()
      aiModelBtn.textContent = m
      ctx.aiPanel.refreshMeta()
      toast(`模型：${m}`, 1200)
    }
    row('模型', '', aiModelBtn)

    const keyBtn = el('button', { class: 'ghost' }, '设置密钥…')
    invoke<boolean>('ai.hasKey').then((has) => { if (has) keyBtn.textContent = '已配置 · 更换…' }).catch(() => {})
    keyBtn.addEventListener('click', async () => {
      const v = await prompt({ title: 'API Key', label: '保存在本地，仅本人可读（0600）', password: true, placeholder: 'sk-…' })
      if (v !== null) {
        await invoke('ai.setKey', { key: v.trim() }).catch(() => {})
        keyBtn.textContent = v.trim() ? '已配置 · 更换…' : '设置密钥…'
        toast(v.trim() ? '密钥已保存' : '已清除密钥')
      }
    })
    row('API Key', '存在配置目录，不在笔记里，也不进日志', keyBtn)

    const testBtn = el('button', { class: 'ghost' }, '测试连接')
    testBtn.addEventListener('click', async () => {
      testBtn.textContent = '测试中…'
      const res = await invoke<{ ok: boolean; message: string }>('ai.test', {
        baseURL: s.aiBaseUrl, model: s.aiModel
      }).catch((e) => ({ ok: false, message: String(e?.message ?? e) }))
      testBtn.textContent = '测试连接'
      toast(res.ok ? '连接成功' : `失败：${res.message}`, 3500)
    })
    row('连接测试', '', testBtn)

    body.append(el('div', { class: 'sheet-section' }, '帮助'))
    const keysBtn = el('button', { class: 'ghost' }, '查看快捷键…')
    keysBtn.addEventListener('click', () => { close(); openShortcuts() })
    row('快捷键', '所有可用的键盘组合', keysBtn)

    const done = el('button', { class: 'primary' }, '完成')
    done.addEventListener('click', () => close())
    body.append(el('div', { class: 'sheet-actions' }, done))
  })
}
