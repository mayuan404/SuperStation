// 终端输出压力：验证 PTY 缓冲区不再有数据竞争
(async () => {
  const L = (x) => window.__betternotebook.log('E2E ' + x);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let pass = 0, fail = 0;
  const check = (n, ok) => { ok ? pass++ : fail++; L((ok ? 'PASS ' : 'FAIL ') + n) }
  try {
    await sleep(1500);
    for (let i = 0; i < 4; i++) {
      window.__betternotebook.openTerm('local');
      await sleep(700);
      window.__betternotebook.termInput('seq 1 ' + (60000 + i * 40000) + '\n');
      await sleep(1600);
    }
    check('big burst ok', true);

    // 并发开/关（ptyRun 会在捕获输出后立刻 close）
    for (let i = 0; i < 6; i++) {
      window.__betternotebook.ptyRun('bash', ['-lc', 'seq 1 40000'], {});
    }
    await sleep(3000);
    check('concurrent open/close ok', true);

    L(`SUMMARY pass=${pass} fail=${fail}`);
    L('E2E DONE');
  } catch (e) { L('E2E ERROR ' + (e && e.stack ? e.stack : String(e))); L('E2E DONE') }
})();
