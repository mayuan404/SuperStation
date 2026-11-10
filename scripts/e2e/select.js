// 文本选择与复制：双击选行、⌘↑/⌘↓ 整行跳、预览双击选行、复制进系统剪贴板
(async () => {
  const L = (x) => window.__betternotebook.log('E2E ' + x);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qa = (s) => Array.from(document.querySelectorAll(s));
  let pass = 0, fail = 0;
  const check = (n, ok, extra) => { ok ? pass++ : fail++; L((ok ? 'PASS ' : 'FAIL ') + n + (extra ? ' :: ' + extra : '')) };
  const cur = () => window.__betternotebook.cursorInfo();
  const key = (k, mods = {}) =>
    document.querySelector('.cm-content').dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }));
  const dbl = (el, dx = 20, dy = null) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true, cancelable: true, detail: 2, button: 0,
      clientX: r.left + dx, clientY: dy ?? r.top + r.height / 2
    }))
  }

  try {
    await sleep(1500)
    const p = '/tmp/e2e-select.md'
    await window.__betternotebook.invoke('fs.write', { path: p, text: 'AAAA BBBB\nCCCC DDDD\nEEEE FFFF\n' })
    await window.__betternotebook.open(p)
    await sleep(900)
    window.__betternotebook.view('editor')
    await sleep(600)

    // 双击选整行（编辑区）
    const line2 = qa('.cm-line').find((l) => /CCCC DDDD/.test(l.textContent))
    check('editor row found', !!line2)
    dbl(line2)
    await sleep(250)
    check('editor double-click selects whole row', cur().text === 'CCCC DDDD', JSON.stringify(cur()))

    // ⌘C 写进系统剪贴板（由宿主返回的剪贴板内容校验）
    document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true }))
    await sleep(400)

    // ⌘↑/⌘↓ 以整行为单位：行首 → 本行行尾，行尾 → 下一行行尾
    qa('.cm-line')[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0, detail: 1 }))
    window.__betternotebook.view('editor')
    await sleep(200)
    key('ArrowDown', { metaKey: true, keyCode: 40 })
    await sleep(150)
    const atEnd = cur()
    key('ArrowDown', { metaKey: true, keyCode: 40 })
    await sleep(150)
    const nextEnd = cur()
    if (atEnd.col > 1 && nextEnd.line > atEnd.line) {
      check('cmd+down lands on line end then next line end', true, JSON.stringify([atEnd, nextEnd]))
    } else {
      check('cmd+down lands on line end then next line end', false, JSON.stringify([atEnd, nextEnd]))
    }

    // 预览：双击选整行
    window.__betternotebook.view('preview')
    await sleep(700)
    const para = qa('.md p').find((e) => /AAAA/.test(e.textContent))
    check('preview paragraph found', !!para)
    if (para) {
      // 双击点在第一段第一行的文字上（段落首行）
      const r0 = para.getBoundingClientRect()
      para.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, detail: 2, button: 0,
        clientX: r0.left + 2, clientY: r0.top + 9
      }))
      await sleep(250)
      const t = window.getSelection().toString()
      check('preview double-click selects whole row', /AAAA BBBB/.test(t) && !t.includes('CCCC'), JSON.stringify(t))
      document.querySelector('.md').dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true }))
      await sleep(300)
    }

    L(`SUMMARY pass=${pass} fail=${fail}`)
    L('E2E DONE')
  } catch (e) { L('SEL ERR ' + (e && e.stack ? e.stack : String(e))); L('E2E DONE') }
})()
