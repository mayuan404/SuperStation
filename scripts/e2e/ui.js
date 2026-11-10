// 终端搜索 + 树多选
(async () => {
  const L = (x) => window.__betternotebook.log('E2E ' + x);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  let pass = 0, fail = 0;
  const check = (n, ok) => { ok ? pass++ : fail++; L((ok ? 'PASS ' : 'FAIL ') + n) }
  try {
    await sleep(1500);
    window.__betternotebook.openTerm('local');
    await sleep(2200);
    window.__betternotebook.termInput('echo SEARCHME\n');
    await sleep(1200);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true }));
    await sleep(400);
    const bar = q('.term-search');
    check('terminal search bar opens', !!bar && getComputedStyle(bar).display !== 'none');
    const input = q('.term-search-input');
    if (input) { input.value = 'SEARCHME'; input.dispatchEvent(new Event('input')); }
    await sleep(400);
    check('terminal search input works', !!input && input.value === 'SEARCHME');

    // 多选
    qa('.tab').find((t) => t.querySelector('.nm')?.textContent === '终端')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(300);
    // 先展开一个根，拿到两个“真实条目”行（根行不参与多选）
    const rootRow = qa('.tree-row').find((r) => r.dataset.root === '1');
    // 只在没展开时点一下，避免把已经展开的根又收回去
    if (rootRow && !rootRow.classList.contains('open')) rootRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(900);
    let rows = qa('.tree-row').filter((r) => r.dataset.root !== '1');
    if (rows.length >= 2) {
      rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(300);
      rows = qa('.tree-row').filter((r) => r.dataset.root !== '1');
      rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
      await sleep(200);
      check('multi select marks rows', qa('.tree-row.multi').length >= 2);
      qa('.tree-row').filter((r) => r.dataset.root !== '1')[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
      await sleep(300);
      const labels = qa('.ctx .mi-label').map((e) => e.textContent || '');
      L('E2E MENU ' + JSON.stringify(labels));
      check('batch menu shows count', labels.some((t) => /项/.test(t) && /废纸篓/.test(t)));
    } else { check('tree has rows', false) }
    L(`SUMMARY pass=${pass} fail=${fail}`);
    L('E2E DONE');
  } catch (e) { L('E2E ERROR ' + (e && e.stack ? e.stack : String(e))); L('E2E DONE') }
})();
