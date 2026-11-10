// 远端文件面板：多个 SSH/远端面板只能显示当前标签对应的那一个
(async () => {
  const L = (x) => window.__betternotebook.log('E2E ' + x);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const vis = (e) => e && e.offsetParent !== null;
  let pass = 0, fail = 0;
  const check = (n, ok) => { ok ? pass++ : fail++; L((ok ? 'PASS ' : 'FAIL ') + n) };
  const fileTabs = () => qa('.tab').filter((t) => (t.querySelector('.nm')?.textContent || '').includes('文件'));
  try {
    await sleep(1500);
    const before = qa('.browser.remote').length;
    window.__betternotebook.openRemoteMock();
    await sleep(600);
    window.__betternotebook.openRemoteMock();
    await sleep(900);

    check('two remote panels created', qa('.browser.remote').length === before + 2);
    check('only active remote panel is visible', qa('.browser.remote').filter(vis).length === 1);

    const tabs = fileTabs();
    check('two remote file tabs', tabs.length >= 2);
    if (tabs.length >= 2) {
      tabs[tabs.length - 2]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(500);
      check('switching tab keeps one visible panel', qa('.browser.remote').filter(vis).length === 1);
      tabs[tabs.length - 1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(500);
      check('switching back keeps one visible panel', qa('.browser.remote').filter(vis).length === 1);
    }

    // 关闭测试创建的两个标签，恢复原状态
    for (const t of fileTabs().slice(-2)) {
      t.querySelector('.close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    await sleep(800);
    check('closing remote tabs removes panels', qa('.browser.remote').length === before);

    L(`SUMMARY pass=${pass} fail=${fail}`);
    L('E2E DONE');
  } catch (e) { L('E2E ERROR ' + (e && e.stack ? e.stack : String(e))); L('E2E DONE') }
})();
