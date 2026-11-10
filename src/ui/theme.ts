// 主题系统：50 套配色 + 独立图标配色。颜色在运行时计算成 CSS 变量，
// 所以新增主题只需要加一行数据，不用写 CSS。

export interface ThemeDef {
  id: string
  name: string
  dark: boolean
  bg: string
  fg: string
  accent: string
  /** keyword, string, number, function, type */
  syn: [string, string, string, string, string]
}

const hex2rgb = (h: string): [number, number, number] => {
  const s = h.replace('#', '')
  const v = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
}
const rgb2hex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')

export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hex2rgb(a)
  const [r2, g2, b2] = hex2rgb(b)
  return rgb2hex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t)
}
const alpha = (h: string, a: number): string => {
  const [r, g, b] = hex2rgb(h)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

const T = (id: string, name: string, dark: boolean, bg: string, fg: string, accent: string, syn: [string, string, string, string, string]): ThemeDef =>
  ({ id, name, dark, bg, fg, accent, syn })

export const THEMES: ThemeDef[] = [
  T('daylight', '晨光 · Daylight', false, '#ffffff', '#1f2023', '#3b6cf6', ['#a626a4', '#2f8f4e', '#b76b01', '#3b6cf6', '#b07d00']),
  T('midnight', '夜幕 · Midnight', true, '#1c1d21', '#e7e8ea', '#7aa2ff', ['#c792ea', '#a5e075', '#f78c6c', '#82aaff', '#ffcb6b']),
  T('one-dark', 'Atom One Dark', true, '#282c34', '#abb2bf', '#61afef', ['#c678dd', '#98c379', '#d19a66', '#61afef', '#e5c07b']),
  T('one-dark-pro', 'One Dark Pro', true, '#282c34', '#abb2bf', '#61afef', ['#c678dd', '#98c379', '#d19a66', '#61afef', '#e5c07b']),
  T('dracula', 'Dracula', true, '#282a36', '#f8f8f2', '#bd93f9', ['#ff79c6', '#f1fa8c', '#bd93f9', '#50fa7b', '#8be9fd']),
  T('dracula-soft', 'Dracula Soft', true, '#282a36', '#f8f8f2', '#ff79c6', ['#ff79c6', '#f1fa8c', '#bd93f9', '#50fa7b', '#8be9fd']),
  T('nord', 'Nord', true, '#2e3440', '#eceff4', '#88c0d0', ['#81a1c1', '#a3be8c', '#b48ead', '#88c0d0', '#8fbcbb']),
  T('solarized-dark', 'Solarized Dark', true, '#002b36', '#839496', '#268bd2', ['#859900', '#2aa198', '#d33682', '#268bd2', '#b58900']),
  T('solarized-light', 'Solarized Light', false, '#fdf6e3', '#586e75', '#268bd2', ['#859900', '#2aa198', '#d33682', '#268bd2', '#b58900']),
  T('gruvbox-dark', 'Gruvbox Dark', true, '#282828', '#ebdbb2', '#fabd2f', ['#fb4934', '#b8bb26', '#d3869b', '#fabd2f', '#83a598']),
  T('gruvbox-light', 'Gruvbox Light', false, '#fbf1c7', '#3c3836', '#b57614', ['#9d0006', '#79740e', '#8f3f71', '#b57614', '#076678']),
  T('monokai', 'Monokai', true, '#272822', '#f8f8f2', '#a6e22e', ['#f92672', '#e6db74', '#ae81ff', '#a6e22e', '#66d9ef']),
  T('monokai-pro', 'Monokai Pro', true, '#2d2a2e', '#fcfcfa', '#ffd866', ['#ff6188', '#ffd866', '#ab9df2', '#a9dc76', '#78dce8']),
  T('material-dark', 'Material Dark', true, '#263238', '#eeffff', '#82aaff', ['#c792ea', '#c3e88d', '#f78c6c', '#82aaff', '#ffcb6b']),
  T('material-ocean', 'Material Ocean', true, '#0f111a', '#8f93a2', '#84ffff', ['#c792ea', '#c3e88d', '#f78c6c', '#82aaff', '#ffcb6b']),
  T('material-lighter', 'Material Lighter', false, '#fafafa', '#90a4ae', '#2979ff', ['#7c4dff', '#91b859', '#f76d47', '#6182b8', '#e2931d']),
  T('github-light', 'GitHub Light', false, '#ffffff', '#1f2328', '#0969da', ['#cf222e', '#0a3069', '#0550ae', '#8250df', '#116329']),
  T('github-dark', 'GitHub Dark', true, '#0d1117', '#c9d1d9', '#58a6ff', ['#ff7b72', '#a5d6ff', '#79c0ff', '#d2a8ff', '#7ee787']),
  T('tokyo-night', 'Tokyo Night', true, '#1a1b26', '#c0caf5', '#7aa2f7', ['#bb9af7', '#9ece6a', '#ff9e64', '#7aa2f7', '#2ac3de']),
  T('tokyo-night-storm', 'Tokyo Night Storm', true, '#24283b', '#c0caf5', '#7aa2f7', ['#bb9af7', '#9ece6a', '#ff9e64', '#7aa2f7', '#2ac3de']),
  T('rose-pine', 'Rosé Pine', true, '#191724', '#e0def4', '#c4a7e7', ['#c4a7e7', '#f6c177', '#eb6f92', '#9ccfd8', '#c4a7e7']),
  T('rose-pine-moon', 'Rosé Pine Moon', true, '#232136', '#e0def4', '#c4a7e7', ['#c4a7e7', '#f6c177', '#ea9a97', '#9ccfd8', '#c4a7e7']),
  T('rose-pine-dawn', 'Rosé Pine Dawn', false, '#faf4ed', '#575279', '#907aa9', ['#907aa9', '#ea9d34', '#d7827e', '#56949f', '#286983']),
  T('catppuccin-latte', 'Catppuccin Latte', false, '#eff1f5', '#4c4f69', '#1e66f5', ['#8839ef', '#40a02b', '#fe640b', '#1e66f5', '#df8e1d']),
  T('catppuccin-frappe', 'Catppuccin Frappé', true, '#303446', '#c6d0f5', '#8caaee', ['#ca9ee6', '#a6d189', '#ef9f76', '#8caaee', '#e5c890']),
  T('catppuccin-macchiato', 'Catppuccin Macchiato', true, '#24273a', '#cad3f5', '#8aadf4', ['#c6a0f6', '#a6da95', '#f5a97f', '#8aadf4', '#eed49f']),
  T('catppuccin-mocha', 'Catppuccin Mocha', true, '#1e1e2e', '#cdd6f4', '#89b4fa', ['#cba6f7', '#a6e3a1', '#fab387', '#89b4fa', '#f9e2af']),
  T('night-owl', 'Night Owl', true, '#011627', '#d6deeb', '#82aaff', ['#c792ea', '#ecc48d', '#f78c6c', '#82aaff', '#ffcb8b']),
  T('light-owl', 'Light Owl', false, '#fbfbfb', '#403f53', '#4876d6', ['#994cc3', '#c96765', '#aa0982', '#4876d6', '#0c969b']),
  T('ayu-dark', 'Ayu Dark', true, '#0b0e14', '#bfbdb6', '#e6b450', ['#ff8f40', '#aad94c', '#d2a6ff', '#ffb454', '#59c2ff']),
  T('ayu-mirage', 'Ayu Mirage', true, '#1f2430', '#cbccc6', '#ffcc66', ['#ffa759', '#bae67e', '#d4bfff', '#73d0ff', '#ffd580']),
  T('ayu-light', 'Ayu Light', false, '#fafafa', '#5c6166', '#ffaa33', ['#fa8d3e', '#86b300', '#a37acc', '#399ee6', '#f2ae49']),
  T('everforest-dark', 'Everforest Dark', true, '#2d353b', '#d3c6aa', '#a7c080', ['#e67e80', '#a7c080', '#d699b6', '#7fbbb3', '#dbbc7f']),
  T('everforest-light', 'Everforest Light', false, '#fdf6e3', '#5c6a72', '#8da101', ['#f85552', '#8da101', '#df69ba', '#3a94c5', '#dfa000']),
  T('kanagawa', 'Kanagawa', true, '#1f1f28', '#dcd7ba', '#7e9cd8', ['#957fb8', '#98bb6c', '#d27e99', '#7e9cd8', '#e6c384']),
  T('vitesse-dark', 'Vitesse Dark', true, '#121212', '#dbd7ca', '#4d9375', ['#4d9375', '#c98a7d', '#b8a965', '#4d9375', '#cb7676']),
  T('vitesse-light', 'Vitesse Light', false, '#ffffff', '#393a34', '#1e754f', ['#1e754f', '#b56959', '#a65e2e', '#1e754f', '#b07d48']),
  T('poimandres', 'Poimandres', true, '#1b1e28', '#a6accd', '#89ddff', ['#d0679d', '#5de4c7', '#f087bd', '#89ddff', '#fffac2']),
  T('cobalt2', 'Cobalt2', true, '#193549', '#ffffff', '#ffc600', ['#ff9d00', '#a5ff90', '#fb94ff', '#ffc600', '#9effff']),
  T('synthwave-84', 'Synthwave 84', true, '#262335', '#ffffff', '#f92aad', ['#f92aad', '#ff8b39', '#fede5d', '#36f9f6', '#72f1b8']),
  T('shades-of-purple', 'Shades of Purple', true, '#2e1e35', '#ffffff', '#c694ff', ['#fad000', '#a5ff90', '#ff628c', '#9effff', '#ffc600']),
  T('winter-is-coming', 'Winter is Coming', true, '#0e1726', '#d6deeb', '#82aaff', ['#c792ea', '#c3e88d', '#f78c6c', '#82aaff', '#ffcb8b']),
  T('panda', 'Panda', true, '#292a2b', '#e6e6e6', '#ff75b5', ['#ff75b5', '#19f9d8', '#ffb86c', '#6fc1ff', '#ffcc95']),
  T('moonlight', 'Moonlight', true, '#1e2030', '#d6d6d6', '#82aaff', ['#c099ff', '#c3e88d', '#ff966c', '#82aaff', '#ffc777']),
  T('horizon', 'Horizon', true, '#1c1e26', '#d5d8da', '#e95678', ['#e95678', '#fadad1', '#fab795', '#25b0bc', '#fac29a']),
  T('andromeda', 'Andromeda', true, '#23262e', '#d5ced9', '#96e072', ['#c74ded', '#96e072', '#ffe66d', '#00e8c6', '#ff9800']),
  T('city-lights', 'City Lights', true, '#1d252c', '#b7c5d3', '#5ec4ff', ['#5ec4ff', '#70e1b4', '#f79f6a', '#5ec4ff', '#e0a370']),
  T('dark-plus', 'Dark+', true, '#1e1e1e', '#d4d4d4', '#569cd6', ['#c586c0', '#ce9178', '#b5cea8', '#dcdcaa', '#4ec9b0']),
  T('light-plus', 'Light+', false, '#ffffff', '#1f1f1f', '#007acc', ['#af00db', '#a31515', '#098658', '#795e26', '#267f99']),
  T('quiet-light', 'Quiet Light', false, '#f5f5f5', '#333333', '#7a3e9d', ['#7a3e9d', '#448c27', '#aa3731', '#325cc0', '#4b69c6']),
  T('oceanic-next', 'Oceanic Next', true, '#1b2b34', '#d8dee9', '#6699cc', ['#c594c5', '#99c794', '#f99157', '#6699cc', '#fac863']),
  T('palenight', 'Palenight', true, '#292d3e', '#a6accd', '#c792ea', ['#c792ea', '#c3e88d', '#f78c6c', '#82aaff', '#ffcb6b']),
  T('vscode-dark-plus', 'VS Code Dark+', true, '#1e1e1e', '#d4d4d4', '#007acc', ['#c586c0', '#ce9178', '#b5cea8', '#dcdcaa', '#4ec9b0']),
  T('vscode-light-plus', 'VS Code Light+', false, '#ffffff', '#000000', '#007acc', ['#af00db', '#a31515', '#098658', '#795e26', '#267f99']),
  T('nord-light', 'Nord Light', false, '#eceff4', '#2e3440', '#5e81ac', ['#81a1c1', '#a3be8c', '#b48ead', '#5e81ac', '#8fbcbb']),
  T('one-monokai', 'One Monokai', true, '#282c34', '#abb2bf', '#61afef', ['#e06c75', '#98c379', '#d19a66', '#61afef', '#e5c07b']),
  T('material-palenight', 'Material Palenight', true, '#292d3e', '#a6accd', '#82aaff', ['#c792ea', '#c3e88d', '#f78c6c', '#82aaff', '#ffcb6b']),
  T('material-darker', 'Material Darker', true, '#212121', '#eeffff', '#82aaff', ['#c792ea', '#c3e88d', '#f78c6c', '#82aaff', '#ffcb6b']),
  T('github-dimmed', 'GitHub Dimmed', true, '#22272e', '#adbac7', '#539bf5', ['#f47067', '#96d0ff', '#6cb6ff', '#dcbdfb', '#f69d50']),
  T('github-hc', 'GitHub High Contrast', true, '#0a0c10', '#f0f3f6', '#71b7ff', ['#ff9492', '#a5d6ff', '#79c0ff', '#dcbdfb', '#f0b72f']),
  T('night-owl-light', 'Light Owl', false, '#fbfbfb', '#403f53', '#2aa298', ['#994cc3', '#c96765', '#aa0982', '#4876d6', '#0c969b']),
  T('tokyo-night-light', 'Tokyo Night Light', false, '#d5d6db', '#343b58', '#34548a', ['#5a4a78', '#485e30', '#965027', '#34548a', '#0f4b6e']),
  T('everforest', 'Everforest', true, '#2d353b', '#d3c6aa', '#a7c080', ['#e67e80', '#a7c080', '#d699b6', '#7fbbb3', '#dbbc7f']),
  T('spacegray', 'Spacegray', true, '#20242d', '#b3b8c6', '#7aa2f7', ['#b48ead', '#a3be8c', '#d08770', '#8fa1b3', '#ebcb8b']),
  T('atom-dark', 'Atom Dark', true, '#282c34', '#abb2bf', '#61afef', ['#c678dd', '#98c379', '#d19a66', '#61afef', '#e5c07b']),
  T('atom-light', 'Atom Light', false, '#ffffff', '#383a42', '#4078f2', ['#a626a4', '#50a14f', '#986801', '#4078f2', '#c18401']),
  T('xcode-dark', 'Xcode Dark', true, '#292a30', '#dfdfe0', '#5dd8ff', ['#fc5fa3', '#fc6a5d', '#d0bf69', '#67b7a4', '#5dd8ff']),
  T('mariana', 'Mariana', true, '#343d46', '#d8dee9', '#6699cc', ['#c695c6', '#99c794', '#f9ae58', '#6699cc', '#fac761']),

  T('darcula', 'Darcula', true, '#2b2b2b', '#a9b7c6', '#cc7832', ['#cc7832', '#6a8759', '#6897bb', '#ffc66d', '#a9b7c6']),
  T('intellij-light', 'IntelliJ Light', false, '#ffffff', '#000000', '#0033b3', ['#0033b3', '#067d17', '#1750eb', '#00627a', '#000000']),
  T('fleet-dark', 'Fleet Dark', true, '#181a1f', '#c5c8c6', '#4a9eff', ['#c792ea', '#9ecbff', '#f78c6c', '#82aaff', '#ffcb6b']),
  T('vim-dark', 'Vim Dark', true, '#121314', '#d0d0d0', '#5f87d7', ['#b48ead', '#a3be8c', '#d08770', '#8fa1b3', '#ebcb8b']),
  T('emacs-dark', 'Emacs Dark', true, '#1f1f1f', '#e0e0e0', '#6b9ef0', ['#c678dd', '#98c379', '#d19a66', '#61afef', '#e5c07b']),
  T('zenburn', 'Zenburn', true, '#3f3f3f', '#dcdccc', '#f0dfaf', ['#f0dfaf', '#cc9393', '#dfaf8f', '#8cd0d3', '#93e0e3']),
  T('papercolor-light', 'PaperColor Light', false, '#eeeeee', '#444444', '#0087af', ['#0087af', '#d70087', '#8700af', '#005faf', '#005f5f']),
  T('seoul256', 'Seoul256', true, '#1e1e1e', '#d0d0d0', '#7fa6c6', ['#d78787', '#87d787', '#d7d787', '#87afd7', '#d7af87']),
  T('tender', 'Tender', true, '#282828', '#eeeeee', '#f6bd3a', ['#e2797f', '#e5d9a4', '#9bb7ec', '#f6bd3a', '#a4b1cd']),
  T('iceberg-dark', 'Iceberg Dark', true, '#161821', '#c6c8d1', '#84a0c6', ['#a093c7', '#b4be82', '#e27878', '#84a0c6', '#89b8c2']),
  T('iceberg-light', 'Iceberg Light', false, '#e8e9ec', '#33374c', '#2d539e', ['#7759b4', '#668e3d', '#cc517a', '#2d539e', '#3f83a6']),
  T('gotham', 'Gotham', true, '#0c1014', '#99d1ce', '#2aa298', ['#d26937', '#edd367', '#f7b9a0', '#2aa298', '#b2c1c0']),
  T('cyberdream', 'Cyberdream', true, '#16161c', '#e6e6e6', '#5cc9ff', ['#ff3570', '#f9f9f9', '#ff9b5e', '#00c9c8', '#ffd166']),
  T('melange-dark', 'Melange Dark', true, '#2a2520', '#ece1d7', '#e5a05f', ['#c25a3c', '#8ab38a', '#d9955f', '#e5a05f', '#d8b46a']),
  T('melange-light', 'Melange Light', false, '#f4f0e8', '#3a322b', '#9a5a2a', ['#a03a2a', '#5a7a4a', '#8a6a1a', '#9a5a2a', '#7a5a2a']),
  T('oxocarbon', 'Oxocarbon', true, '#161616', '#f2f4f8', '#00c8ff', ['#ff7eb6', '#42be65', '#be95ff', '#33b1ff', '#82cfff']),
  T('aura-dark', 'Aura Dark', true, '#15141b', '#edecee', '#a277ff', ['#a277ff', '#61ffca', '#ffca85', '#f694ff', '#82e2ff']),
  T('aura-soft', 'Aura Soft', true, '#1c1b23', '#edecee', '#a277ff', ['#a277ff', '#61ffca', '#ffca85', '#f694ff', '#82e2ff']),
  T('snazzy', 'Snazzy', true, '#282a36', '#eff0eb', '#57c7ff', ['#ff5c57', '#5af78e', '#f3f99d', '#57c7ff', '#9aedfe']),
  T('laserwave', 'Laserwave', true, '#1a1626', '#f0e7ff', '#ff6ac1', ['#ff6ac1', '#a8ff60', '#ffd23f', '#5ddbff', '#b8a1ff']),
  T('nocturnal', 'Nocturnal', true, '#0f1720', '#c5d4e0', '#6ec2e8', ['#e07a8b', '#8ac98a', '#e8b46a', '#6ec2e8', '#b39ddb']),
  T('halcyon', 'Halcyon', true, '#1d2433', '#d5dbea', '#7bb3ff', ['#ff9e64', '#9ece6a', '#ffb86c', '#7bb3ff', '#bb9af7']),
  T('flexoki-dark', 'Flexoki Dark', true, '#100f0f', '#cecdc3', '#4385be', ['#d14d41', '#879a39', '#da702c', '#4385be', '#8b7ec8']),
  T('flexoki-light', 'Flexoki Light', false, '#fffcf0', '#100f0f', '#205ea6', ['#af3029', '#66800b', '#bc5215', '#205ea6', '#5e409d']),
  T('kanagawa-lotus', 'Kanagawa Lotus', false, '#f2ecbc', '#545464', '#4d699b', ['#c84053', '#6f894e', '#b35b79', '#4d699b', '#77713f']),
  T('kanagawa-dragon', 'Kanagawa Dragon', true, '#181616', '#c5c9c5', '#8ba4b0', ['#c4746e', '#87a987', '#d4b261', '#8ba4b0', '#b98d7b']),
  T('zenwritten-dark', 'Zenwritten Dark', true, '#191919', '#bbbbbb', '#6a9fb5', ['#a89bb9', '#789978', '#d7a771', '#6a9fb5', '#a8a8a8']),
  T('zenwritten-light', 'Zenwritten Light', false, '#f4f4f4', '#212121', '#2f6a8a', ['#7a4e8a', '#4a7a4a', '#8a5a2a', '#2f6a8a', '#555555']),
  T('nephrite', 'Nephrite', true, '#1c2a28', '#c8d3d0', '#5fb3a1', ['#e08a8a', '#8fc79a', '#e0c08a', '#5fb3a1', '#a8c7c0']),
  T('meadow-light', 'Meadow Light', false, '#f5f0e8', '#3a3a3a', '#7a8a3a', ['#a05a3a', '#5a7a3a', '#a08a2a', '#3a6a8a', '#7a5a3a']),
  T('solar-flare', 'Solar Flare', true, '#12100e', '#e8d5b7', '#ff9d5c', ['#ff6b6b', '#a8d08d', '#ffd166', '#ff9d5c', '#f2c38a']),
  T('deep-ocean', 'Deep Ocean', true, '#0a192f', '#ccd6f6', '#64ffda', ['#f07178', '#c3e88d', '#f78c6c', '#82aaff', '#ffcb6b']),
  T('adwaita-dark', 'Adwaita Dark · 默认语法', true, '#1d1d1d', '#d4d4d4', '#3584e4', ['#569cd6', '#ce9178', '#b5cea8', '#dcdcaa', '#4ec9b0']),

]

export const ICON_SETS = [
  { id: 'auto', name: '跟随主题', hint: '图标颜色取自当前主题的语法配色' },
  { id: 'seti', name: 'Seti', hint: 'VS Code 默认 Seti 配色' },
  { id: 'material', name: 'Material', hint: 'Material Icon Theme 配色' },
  { id: 'mono', name: '单色', hint: '统一为次级前景色' }
] as const

const ICON_ROLE: Record<string, string> = {
  md: 'md', markdown: 'md', mdx: 'md',
  json: 'json', yaml: 'json', yml: 'json', toml: 'json', ini: 'json',
  js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', tsx: 'ts', jsx: 'ts',
  py: 'py', go: 'go', rs: 'rs', c: 'c', h: 'c', cpp: 'c', hpp: 'c', m: 'c',
  html: 'html', htm: 'html', css: 'css', scss: 'css', less: 'css',
  sh: 'sh', bash: 'sh', zsh: 'sh', sql: 'sql', xml: 'xml', svg: 'img',
  png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img', avif: 'img', ico: 'img',
  csv: 'csv', tsv: 'csv', pdf: 'pdf', epub: 'epub', txt: 'txt',
  zip: 'zip', tar: 'zip', gz: 'zip', tgz: 'zip', bnenc: 'lock'
}

const SETI: Record<string, string> = {
  md: '#519aba', json: '#cbcb41', js: '#e6c447', ts: '#519aba', py: '#4b8bbe',
  go: '#4bd5e0', rs: '#dea584', c: '#a8b9cc', html: '#e34c26', css: '#563d7c',
  sh: '#89e051', sql: '#dad8d8', xml: '#e37933', img: '#a074c4', csv: '#89e051',
  pdf: '#e34c26', epub: '#a074c4', txt: '#9aa0a8', zip: '#cbcb41', lock: '#e5484d'
}

const MATERIAL: Record<string, string> = {
  md: '#42a5f5', json: '#f9a825', js: '#fbc02d', ts: '#0288d1', py: '#0288d1',
  go: '#00acc1', rs: '#bf360c', c: '#90a4ae', html: '#e44d26', css: '#42a5f5',
  sh: '#4e9a06', sql: '#42a5f5', xml: '#fbc02d', img: '#7e57c2', csv: '#4e9a06',
  pdf: '#e44d26', epub: '#7e57c2', txt: '#90a4ae', zip: '#f9a825', lock: '#ef5350'
}

function autoIcon(role: string, t: ThemeDef): string {
  const [kw, str, num, fn, type] = t.syn
  switch (role) {
    case 'md': return fn
    case 'json': return num
    case 'js': return num
    case 'ts': return type
    case 'py': return fn
    case 'go': return type
    case 'rs': return num
    case 'c': return mix(t.fg, t.bg, 0.25)
    case 'html': return kw
    case 'css': return fn
    case 'sh': return str
    case 'sql': return num
    case 'xml': return type
    case 'img': return t.accent
    case 'csv': return str
    case 'pdf': return kw
    case 'epub': return t.accent
    case 'txt': return mix(t.fg, t.bg, 0.4)
    case 'zip': return num
    case 'lock': return '#e5484d'
    default: return mix(t.fg, t.bg, 0.45)
  }
}

export function applyIconSet(set: string, t: ThemeDef): void {
  const style = document.documentElement.style
  const roles = ['md', 'json', 'js', 'ts', 'py', 'go', 'rs', 'c', 'html', 'css', 'sh', 'sql', 'xml', 'img', 'csv', 'pdf', 'epub', 'txt', 'zip', 'lock', 'file']
  for (const role of roles) {
    let color = ''
    if (set === 'seti') color = SETI[role] ?? mix(t.fg, t.bg, 0.4)
    else if (set === 'material') color = MATERIAL[role] ?? mix(t.fg, t.bg, 0.4)
    else if (set === 'mono') color = role === 'lock' ? '#e5484d' : mix(t.fg, t.bg, 0.35)
    else color = autoIcon(role, t)
    style.setProperty(`--ic-${role}`, color)
  }
}

export function iconVarFor(ext: string): string {
  const role = ICON_ROLE[ext.toLowerCase()] ?? 'file'
  return `var(--ic-${role})`
}

let currentThemeId = ''
let currentIconSet = 'auto'

export function currentTheme(): ThemeDef {
  return THEMES.find((t) => t.id === currentThemeId) ?? THEMES[0]
}

export function applyTheme(id: string, iconSet = currentIconSet): void {
  const t = THEMES.find((x) => x.id === id) ?? THEMES[0]
  currentThemeId = t.id
  currentIconSet = iconSet
  document.documentElement.dataset.theme = t.dark ? 'dark' : 'light'

  const dark = t.dark
  const panel = mix(t.bg, t.fg, dark ? 0.045 : 0.035)
  const panel2 = mix(t.bg, t.fg, dark ? 0.10 : 0.075)
  const elev = dark ? mix(t.bg, t.fg, 0.13) : '#ffffff'
  const fg2 = mix(t.fg, t.bg, dark ? 0.30 : 0.28)
  const fg3 = mix(t.fg, t.bg, dark ? 0.52 : 0.50)
  const [kw, str, num, fn, type] = t.syn

  const style = document.documentElement.style
  const set = (k: string, v: string) => style.setProperty(k, v)
  set('--bg', t.bg)
  set('--panel', panel)
  set('--panel-2', panel2)
  set('--elev', elev)
  set('--fg', t.fg)
  set('--fg-2', fg2)
  set('--fg-3', fg3)
  set('--line', alpha(t.fg, dark ? 0.09 : 0.08))
  set('--line-strong', alpha(t.fg, dark ? 0.18 : 0.15))
  set('--accent', t.accent)
  set('--accent-2', dark ? mix(t.accent, '#ffffff', 0.18) : mix(t.accent, '#000000', 0.15))
  set('--accent-soft', alpha(t.accent, dark ? 0.16 : 0.12))
  set('--sel', alpha(t.accent, dark ? 0.24 : 0.18))
  set('--syn-kw', kw)
  set('--syn-str', str)
  set('--syn-num', num)
  set('--syn-com', mix(t.fg, t.bg, 0.45))
  set('--syn-fn', fn)
  set('--syn-type', type)
  set('--syn-var', t.fg)
  set('--syn-op', mix(t.accent, t.fg, 0.35))
  set('--syn-tag', kw)
  set('--syn-attr', type)
  set('--syn-const', num)
  set('--shadow', dark
    ? '0 16px 48px rgba(0,0,0,.5), 0 2px 8px rgba(0,0,0,.4)'
    : '0 12px 40px rgba(0,0,0,.10), 0 2px 6px rgba(0,0,0,.06)')
  style.colorScheme = dark ? 'dark' : 'light'

  applyIconSet(iconSet, t)
}

export function isDark(id: string): boolean {
  return THEMES.find((t) => t.id === id)?.dark ?? false
}
