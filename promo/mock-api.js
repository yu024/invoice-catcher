/* 演示用 window.api：不连接任何真实邮箱，按脚本推送示例发票数据。 */
(function () {
  'use strict';
  const listeners = { log: [], state: [], invoice: [], cycle: [], settings: [] };
  const emit = (ch, payload) => listeners[ch].forEach((fn) => fn(payload));
  const on = (ch) => (fn) => {
    listeners[ch].push(fn);
    return () => {};
  };

  const config = {
    email: '',
    protocol: 'imap',
    provider: 'yeah',
    host: 'imap.yeah.net',
    port: 993,
    secure: true,
    mailbox: 'INBOX',
    saveDir: '~/Desktop/发票PDF',
    hasPassword: false,
  };
  let cycle = { number: 1, count: 0, totalAmount: 0, fetchFrom: null };

  const TOTAL = 36;
  // [扫描到第几封, 类型, 内容]
  const SCRIPT = [
    [3, 'save', '滴滴出行_46.50元.pdf', 46.5, '您的滴滴出行电子发票'],
    [6, 'itinerary', '滴滴出行行程报销单.pdf'],
    [8, 'save', '麦当劳_32.90元.pdf', 32.9, '麦当劳电子发票'],
    [11, 'link', '地铁_6.00元.pdf', 6.0, '诺诺发票：地铁乘车电子发票'],
    [15, 'save', '京东_199.00元.pdf', 199.0, '京东电子发票通知'],
    [18, 'dup', '麦当劳_32.90元.pdf'],
    [21, 'save', '滴滴出行_28.70元.pdf', 28.7, '您的滴滴出行电子发票'],
    [25, 'save', '美团_58.00元.pdf', 58.0, '美团电子发票已开具'],
    [29, 'save', '铁路_354.50元.pdf', 354.5, '铁路电子客票发票'],
    [33, 'save', '酒店_268.00元.pdf', 268.0, '酒店住宿电子发票'],
  ];
  const SUBJECTS = ['会员周报', '账单提醒', '项目周会纪要', '快递已签收', '订阅更新'];

  function startScript() {
    const state = { running: true, total: 0, processed: 0, fetched: 0, duplicates: 0, failed: 0, subject: '' };
    const log = (level, text) => emit('log', { level, text, time: Date.now() });
    const push = () => emit('state', { ...state });
    let t = 0;
    const at = (ms, fn) => setTimeout(fn, (t += ms));

    at(10, () => {
      log('info', `开始抓取 · IMAP · ${config.email}`);
      log('info', '本周期起始日：2026-11-01，仅抓取该日期及以后的邮件。');
      push();
    });
    at(450, () => log('info', '连接 imap.yeah.net:993（IMAP）…'));
    at(500, () => log('success', `已连接 ${config.email}`));
    at(350, () => {
      log('info', `扫描 INBOX 中 2026-11-01 及以后的邮件：共 ${TOTAL} 封。`);
      state.total = TOTAL;
      push();
    });

    let step = 0;
    for (let i = 1; i <= TOTAL; i++) {
      const item = SCRIPT.find((s) => s[0] === i);
      at(item ? 300 : 110, () => {
        state.processed = i;
        state.subject = item && item[4] ? item[4] : SUBJECTS[i % SUBJECTS.length];
        if (item) {
          const [, kind, file, amount] = item;
          if (kind === 'itinerary') log('muted', `已忽略行程单（不作为发票）：${file}`);
          else if (kind === 'dup') {
            state.duplicates += 1;
            log('muted', `重复发票已跳过：${file}`);
          } else {
            if (kind === 'link') log('info', '邮件内没有 PDF 附件，正在打开发票链接（nuonuo.com）…');
            const finish = () => {
              if (kind === 'link') log('success', `已从链接获取 PDF：${file}`);
              log('success', `已保存发票：${file} · ¥${amount.toFixed(2)}`);
              emit('invoice', { amount });
              state.fetched += 1;
              push();
            };
            if (kind === 'link') setTimeout(finish, 260);
            else finish();
          }
        }
        push();
      });
      step++;
    }
    at(600, () => {
      log('info', '总览表已更新：~/Desktop/发票总览.xlsx');
      log('success', `抓取完成：新增 ${state.fetched} 张发票，跳过重复 ${state.duplicates} 条，失败 0 条。`);
      state.running = false;
      state.subject = '';
      push();
      if (window.toast) window.toast(`抓取完成：新增 ${state.fetched} 张发票`, 'success', 6000);
    });
  }

  window.api = {
    platform: 'darwin',
    bootstrap: async () => ({
      config,
      cycle,
      paths: { excel: '~/Desktop/发票总览.xlsx' },
      version: '1.0.0',
      running: false,
    }),
    saveSettings: async ({ config: next, password }) => {
      Object.assign(config, next);
      if (password) config.hasPassword = true;
      return { ok: true, config: { ...config } };
    },
    testConnection: () =>
      new Promise((resolve) => setTimeout(() => resolve({ ok: true, message: '连接成功：IMAP 登录正常，INBOX 共 36 封邮件' }), 700)),
    chooseDir: async () => ({ ok: false }),
    start: async () => {
      cycle = { ...cycle, fetchFrom: '2026-11-01' };
      emit('cycle', { cycle });
      startScript();
      return { ok: true };
    },
    stop: async () => ({ ok: true }),
    resetCycle: async () => ({ ok: true, cycle }),
    open: async () => ({ ok: true }),
    onLog: on('log'),
    onState: on('state'),
    onInvoice: on('invoice'),
    onCycle: on('cycle'),
    onSettings: on('settings'),
  };
})();
