// SSH 会话 / 远程工作区 菜单（拆分后回归）
(async () => {
  const L = (x) => window.__betternotebook.log('E2E ' + x);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  let pass = 0, fail = 0;
  const check = (n, ok) => { ok ? pass++ : fail++; L((ok ? 'PASS ' : 'FAIL ') + n) }
  try {
    await sleep(1500);
    q('.sidebar-head button[title="终端 / SSH 会话"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(500);
    const labels = qa('.ctx .mi-label').map((e) => e.textContent || '');
    check('terminal menu opens', labels.some((t) => /本地终端/.test(t)));
    qa('.ctx .mi').find((e) => (e.textContent || '').includes('新建 SSH 会话'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(600);
    check('ssh form opens', q('.modal h3')?.textContent?.includes('SSH'));
    const labels2 = qa('.modal .lbl').map((e) => e.textContent || '');
    check('ssh form has 初始目录', labels2.includes('初始目录'));
    check('ssh form has 密码', labels2.includes('密码'));
    L(`SUMMARY pass=${pass} fail=${fail}`);
    L('E2E DONE');
  } catch (e) { L('E2E ERROR ' + (e && e.stack ? e.stack : String(e))); L('E2E DONE') }
})();
