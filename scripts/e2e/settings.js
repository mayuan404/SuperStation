// 设置面板（拆分后回归）
(async () => {
  const L = (x) => window.__betternotebook.log('E2E ' + x);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  let pass = 0, fail = 0;
  const check = (n, ok) => { ok ? pass++ : fail++; L((ok ? 'PASS ' : 'FAIL ') + n) }
  try {
    await sleep(1500);
    q('.sidebar-foot .settings-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(500);
    check('settings sheet opens', q('.modal h3')?.textContent === '设置');
    check('theme row present', qa('.modal .lbl').some((e) => e.textContent === '外观主题'));
    const keysBtn = qa('.modal button').find((b) => b.textContent.includes('查看快捷键'));
    keysBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(500);
    check('shortcuts sheet opens', q('.modal h3')?.textContent === '快捷键');
    check('shortcut rows rendered', qa('.modal .sheet-row').length >= 10);
    L(`SUMMARY pass=${pass} fail=${fail}`);
    L('E2E DONE');
  } catch (e) { L('E2E ERROR ' + (e && e.stack ? e.stack : String(e))); L('E2E DONE') }
})();
