// 快速命令：管理面板 + SSH 终端按钮 + 选择弹层
// 注意：只操作名字以 "E2E " 开头的命令，绝不碰用户自己的命令。
(async () => {
  const L = (x) => window.__betternotebook.log('E2E ' + x);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const click = (n) => n.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const type = (input, v) => { input.value = v; input.dispatchEvent(new Event('input', { bubbles: true })) };
  const names = () => JSON.parse(localStorage.getItem('betternotebook.settings.v1') || '{}').quickCommands || [];
  const isOurs = (n) => /^E2E /.test(n);
  let pass = 0, fail = 0;
  const check = (n, ok) => { ok ? pass++ : fail++; L((ok ? 'PASS ' : 'FAIL ') + n) };

  const deleteOurs = async () => {
    for (let guard = 0; guard < 30; guard++) {
      const bad = qa('.modal .qc-row').find((r) => isOurs((r.querySelector('.qc-name') || {}).textContent || ''));
      if (!bad) break;
      click(bad.querySelector('.qc-icon-btn.danger'));
      await sleep(220);
      const del = qa('.modal button').find((b) => b.textContent === '删除');
      if (del) click(del);
      await sleep(260);
    }
  };

  try {
    await sleep(1500);
    // 用户已有的命令，测试前后数量必须一致
    const userBefore = names().filter((c) => !isOurs(c.name)).map((c) => c.name).sort();

    const sideBtn = q('.sidebar-head button[title^="快速命令"]');
    check('sidebar has quick command button', !!sideBtn);
    click(sideBtn);
    await sleep(350);
    check('manager sheet opens', /快速命令/.test(q('.modal h3')?.textContent || ''));
    check('manager hint shown', /SSH 终端/.test(q('.modal .body')?.textContent || ''));

    // 先清掉上次残留（只清 E2E 开头的）
    await deleteOurs();

    // 新增
    click(q('.modal .qc-add'));
    await sleep(200);
    const nameInput = q('.modal .qc-editor input.txt');
    const contentInput = q('.modal .qc-content');
    check('editor opens', !!nameInput && !q('.modal .qc-editor').hidden);
    type(nameInput, 'E2E 测试命令');
    type(contentInput, 'df -h');
    click(qa('.modal .qc-editor button').find((b) => b.textContent === '保存'));
    await sleep(350);
    check('command saved and listed', /E2E 测试命令/.test(q('.modal .qc-rows')?.textContent || ''));
    check('command stored globally', names().some((c) => c.name === 'E2E 测试命令' && c.content === 'df -h'));

    // 编辑：按名字找到自己那条，不点第一行
    const mine = qa('.modal .qc-row').find((r) => (r.querySelector('.qc-name') || {}).textContent === 'E2E 测试命令');
    check('can locate own row', !!mine);
    if (mine) {
      click(mine.querySelector('.qc-main'));
      await sleep(220);
      type(q('.modal .qc-editor input.txt'), 'E2E 改名后');
      click(qa('.modal .qc-editor button').find((b) => b.textContent === '保存'));
      await sleep(350);
    }
    check('edit persists', /E2E 改名后/.test(q('.modal .qc-rows')?.textContent || ''));
    check('user commands untouched', JSON.stringify(names().filter((c) => !isOurs(c.name)).map((c) => c.name).sort()) === JSON.stringify(userBefore));

    // 关掉面板
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(250);
    check('manager closes', !q('.modal'));

    // SSH 终端：连接（host 无效会很快失败，但 pty 有输出即视为 live）
    window.__betternotebook.openTerm('ssh');
    let quickBtn = null;
    for (let i = 0; i < 40; i++) {
      quickBtn = q('.term-quick-btn');
      if (quickBtn && !quickBtn.hidden) break;
      await sleep(250);
    }
    check('ssh terminal has quick button', !!q('.term-quick-btn'));
    check('quick button visible after session output', !!quickBtn && !quickBtn.hidden);
    click(quickBtn);
    await sleep(300);
    check('picker opens', !!q('.qc-pop'));
    const picked = qa('.qc-pop .qc-item .qc-name').map((n) => n.textContent);
    L('E2E PICKER ' + JSON.stringify(picked));
    check('picker lists names only', picked.includes('E2E 改名后'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await sleep(300);
    check('picker closes after Enter', !q('.qc-pop'));

    click(quickBtn);
    await sleep(300);
    const box = q('.qc-pop')?.getBoundingClientRect();
    check('picker positioned on screen', !!box && box.left >= 0 && box.top >= 0 && box.bottom <= innerHeight + 1);
    click(q('.qc-pop .qc-item'));
    await sleep(250);
    check('picker closes after click', !q('.qc-pop'));

    // 清理：只删自己留下的
    click(sideBtn);
    await sleep(350);
    await deleteOurs();
    check('test commands removed', !names().some((c) => isOurs(c.name)));
    check('user commands still there', JSON.stringify(names().filter((c) => !isOurs(c.name)).map((c) => c.name).sort()) === JSON.stringify(userBefore));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    L(`SUMMARY pass=${pass} fail=${fail}`);
    L('E2E DONE');
  } catch (e) { L('E2E ERROR ' + (e && e.stack ? e.stack : String(e))); L('E2E DONE') }
})();
