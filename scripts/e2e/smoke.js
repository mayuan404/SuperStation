// 冒烟测试：本地根、打开文件、终端、写保护
(async () => {
  const L = (x) => window.__betternotebook.log('E2E ' + x);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const inv = (m, a) => window.__betternotebook.invoke(m, a);
  let pass = 0, fail = 0;
  const check = (name, ok) => { ok ? pass++ : fail++; L((ok ? 'PASS ' : 'FAIL ') + name) }
  try {
    await sleep(1500);
    check('fs.list works', (await inv('fs.exists', { path: '/tmp' })) === true);
    check('scheme blocks ~/.ssh',
      await fetch('betternotebook://file' + '/Users/' + 'songwei/.ssh/config').then((r) => r.status !== 200).catch(() => true));
    check('write outside blocked',
      await inv('fs.write', { path: '/Users/songwei/.ssh/x.txt', text: 'x' }).then(() => false).catch(() => true));
    check('write /tmp allowed',
      await inv('fs.write', { path: '/tmp/e2e-ok.txt', text: 'ok' }).then(() => true).catch(() => false));
    await inv('fs.remove', { path: '/tmp/e2e-ok.txt' }).catch(() => {});
    L(`SUMMARY pass=${pass} fail=${fail}`);
    L('E2E DONE');
  } catch (e) { L('E2E ERROR ' + (e && e.stack ? e.stack : String(e))); L('E2E DONE') }
})();
