// 侧边栏「本地 / 远程」两个 tab
(async () => {
  const L = (x) => window.__betternotebook.log('E2E ' + x);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const click = (node) => node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  let pass = 0, fail = 0;
  const check = (n, ok) => { ok ? pass++ : fail++; L((ok ? 'PASS ' : 'FAIL ') + n) }
  try {
    await sleep(1500);
    const tabs = qa('.side-tab');
    const labels = tabs.map((t) => t.textContent.trim()).join('|');
    L('E2E LABELS ' + labels);
    check('two sidebar tabs', tabs.length === 2);
    check('tab labels local/remote', tabs.length === 2 && /本地/.test(labels) && /远程/.test(labels));
    check('one pane visible at a time', qa('.tree-pane').filter((p) => !p.hidden).length === 1);
    // 恢复上次的 tab：选中的 tab 和可见的分区必须一致
    const activeIsLocal = /本地/.test((q('.side-tab.active') || {}).textContent || '');
    check('saved tab restored', activeIsLocal === !q('.tree-pane.local').hidden);
    click(tabs.find((t) => /本地/.test(t.textContent)));
    await sleep(500);
    check('local pane visible after click', !q('.tree-pane.local').hidden && q('.tree-pane.remote').hidden);
    check('local rows rendered', qa('.tree-pane.local .tree-row').length > 0);
    await window.__betternotebook.invoke('dev.snapshot', { path: '/tmp/sws-local.png' });
    await sleep(500);

    const remoteCount = (window.__betternotebook.state().remoteRoots || []).length;
    click(tabs.find((t) => /远程/.test(t.textContent)));
    await sleep(500);
    check('remote pane visible after click', !q('.tree-pane.remote').hidden && q('.tree-pane.local').hidden);
    check('remote roots painted immediately', qa('.tree-pane.remote .root-row').length === remoteCount);
    check('footer switches to remote action', /添加远程/.test(q('.sidebar-foot').textContent));
    check('remote tab is active', /远程/.test(q('.side-tab.active').textContent));
    await window.__betternotebook.invoke('dev.snapshot', { path: '/tmp/sws-remote.png' });
    await sleep(600);

    click(qa('.side-tab').find((t) => /本地/.test(t.textContent)));
    await sleep(400);
    check('back to local pane', !q('.tree-pane.local').hidden && q('.tree-pane.remote').hidden);
    check('local rows still rendered', qa('.tree-pane.local .tree-row').length > 0);
    const saved = JSON.parse(localStorage.getItem('betternotebook.settings.v1') || '{}');
    check('tab choice saved', saved.treeTab === 'local');
    L('E2E SAVED ' + saved.treeTab);

    L(`SUMMARY pass=${pass} fail=${fail}`);
    L('E2E DONE');
  } catch (e) { L('E2E ERROR ' + (e && e.stack ? e.stack : String(e))); L('E2E DONE') }
})();
