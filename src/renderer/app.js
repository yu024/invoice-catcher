'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const PRESETS = {
  yeah: { imap: { host: 'imap.yeah.net', port: 993 }, pop3: { host: 'pop.yeah.net', port: 995 } },
  '188': { imap: { host: 'imap.188.com', port: 993 }, pop3: { host: 'pop.188.com', port: 995 } },
  qq: { imap: { host: 'imap.qq.com', port: 993 }, pop3: { host: 'pop.qq.com', port: 995 } },
  '163': { imap: { host: 'imap.163.com', port: 993 }, pop3: { host: 'pop.163.com', port: 995 } },
  '126': { imap: { host: 'imap.126.com', port: 993 }, pop3: { host: 'pop.126.com', port: 995 } },
  sina: { imap: { host: 'imap.sina.com', port: 993 }, pop3: { host: 'pop.sina.com', port: 995 } },
  gmail: { imap: { host: 'imap.gmail.com', port: 993 }, pop3: { host: 'pop.gmail.com', port: 995 } },
  outlook: {
    imap: { host: 'outlook.office365.com', port: 993 },
    pop3: { host: 'outlook.office365.com', port: 995 },
  },
  icloud: { imap: { host: 'imap.mail.me.com', port: 993 }, pop3: { host: 'pop.mail.me.com', port: 995 } },
  aliyun: {
    imap: { host: 'imap.qiye.aliyun.com', port: 993 },
    pop3: { host: 'pop.qiye.aliyun.com', port: 995 },
  },
  custom: null,
};

const LEVEL_ICONS = { info: '›', success: '✓', error: '✕', warn: '!', muted: '·' };
const RING_CIRCUMFERENCE = 2 * Math.PI * 61;

const els = {};
let config = null;
let cycle = { number: 1, count: 0, totalAmount: 0, startedAt: null };
let stats = { total: 0, processed: 0, fetched: 0, duplicates: 0, failed: 0, subject: '' };
let running = false;
let busy = false;
let hasPassword = false;
let protocol = 'imap';
let provider = 'yeah';
let liveCount = 0;
let liveAmount = 0;
let autoscroll = true;
let modalResolver = null;

function cacheEls() {
  [
    'statusPill', 'statusText', 'toggleBtn', 'toggleLabel', 'openTableBtn', 'openTableBtn2',
    'progressLabel', 'progressPct', 'progressBar', 'ringValue', 'ringCount',
    'statFetched', 'statDup', 'statFail', 'statScan', 'statScanTotal',
    'logs', 'autoScroll', 'clearLogs', 'settingsForm', 'email', 'password', 'togglePw',
    'protocol', 'provider', 'host', 'port', 'secure', 'mailbox', 'mailboxField',
    'saveBtn', 'testBtn', 'openFolderBtn', 'saveDirPath', 'excelPath', 'changeDirBtn',
    'cycleBadge', 'cycleCount', 'cycleAmount', 'cycleFrom', 'newCycleBtn', 'footerStatus', 'versionText',
    'toasts', 'modal', 'modalText', 'modalCancel', 'modalConfirm', 'logEmpty',
    'rangeFrom', 'rangeTo', 'rangeWeek', 'rangeClear',
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function formatTime(timestamp) {
  const date = new Date(timestamp || Date.now());
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function formatMoney(value) {
  const number = Number(value) || 0;
  return `¥${number.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function toast(message, type = 'info', timeout = 3600) {
  if (!message) return;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  els.toasts.appendChild(node);
  while (els.toasts.children.length > 4) els.toasts.firstElementChild.remove();
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 240);
  }, timeout);
}

/* ------------------------------ 控制台 ------------------------------ */

function addLog(entry) {
  const empty = $('#logEmpty');
  if (empty) empty.remove();
  const line = document.createElement('div');
  const level = entry.level || 'info';
  line.className = `log-line log-${level}`;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = formatTime(entry.time);

  const icon = document.createElement('span');
  icon.className = 'log-icon';
  icon.textContent = LEVEL_ICONS[level] || '·';

  const message = document.createElement('span');
  message.className = 'log-msg';
  message.textContent = entry.text;

  line.append(time, icon, message);
  els.logs.appendChild(line);
  while (els.logs.children.length > 400) els.logs.firstElementChild.remove();
  if (autoscroll) els.logs.scrollTop = els.logs.scrollHeight;
}

function clearLogs() {
  els.logs.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'log-empty';
  empty.id = 'logEmpty';
  empty.innerHTML = '<span>控制台已清空</span><small>新的抓取记录会继续显示在这里</small>';
  els.logs.appendChild(empty);
}

/* ------------------------------ 表单 ------------------------------ */

function applyConfig(next) {
  if (!next) return;
  config = next;
  hasPassword = Boolean(next.hasPassword);
  protocol = next.protocol === 'pop3' ? 'pop3' : 'imap';
  provider = PRESETS[next.provider] ? next.provider : 'custom';

  els.email.value = next.email || '';
  els.host.value = next.host || '';
  els.port.value = next.port || (protocol === 'imap' ? 993 : 995);
  els.secure.checked = next.secure !== false;
  els.mailbox.value = next.mailbox || 'INBOX';
  els.provider.value = provider;

  $$('#protocol button').forEach((button) => {
    button.classList.toggle('active', button.dataset.value === protocol);
  });
  els.mailboxField.style.display = protocol === 'pop3' ? 'none' : '';
  els.password.value = '';
  els.password.placeholder = hasPassword ? '已保存授权码，留空保持不变' : '邮箱授权码';

  els.saveDirPath.textContent = next.saveDir || '—';
  els.saveDirPath.title = next.saveDir || '';
  updateStatus();
}

function collectConfig() {
  return {
    email: els.email.value.trim(),
    protocol,
    provider,
    host: els.host.value.trim(),
    port: Number(els.port.value) || (protocol === 'imap' ? 993 : 995),
    secure: els.secure.checked,
    mailbox: (els.mailbox.value || 'INBOX').trim(),
    saveDir: config ? config.saveDir : undefined,
  };
}

function validateForm(requirePassword) {
  const data = collectConfig();
  if (!data.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    toast('请填写有效的邮箱地址', 'error');
    els.email.focus();
    return null;
  }
  if (requirePassword && !hasPassword && !els.password.value) {
    toast('请填写邮箱密码或授权码', 'error');
    els.password.focus();
    return null;
  }
  if (!data.host) {
    toast('请填写邮件服务器地址', 'error');
    els.host.focus();
    return null;
  }
  if (!Number.isInteger(data.port) || data.port < 1 || data.port > 65535) {
    toast('端口号必须是 1-65535 之间的数字', 'error');
    return null;
  }
  return data;
}

async function persistSettings(showToast = true) {
  const data = validateForm(false);
  if (!data) return false;
  const password = els.password.value;
  const result = await window.api.saveSettings({ config: data, password: password || undefined });
  if (!result || !result.ok) {
    toast((result && result.error) || '保存失败', 'error');
    return false;
  }
  config = result.config;
  hasPassword = Boolean(result.config.hasPassword);
  els.password.value = '';
  els.password.placeholder = hasPassword ? '已保存授权码，留空保持不变' : '邮箱授权码';
  els.saveDirPath.textContent = result.config.saveDir;
  els.saveDirPath.title = result.config.saveDir;
  updateStatus();
  if (showToast) toast('邮箱设置已保存', 'success');
  return true;
}

/* ------------------------------ UI 状态 ------------------------------ */

function updateStatus() {
  els.statusPill.classList.toggle('running', running);
  els.statusPill.classList.toggle('ready', !running && hasPassword);
  els.statusText.textContent = running ? '正在抓取' : hasPassword ? '已就绪' : '待连接';
}

function setRunningUI(next) {
  running = next;
  els.toggleBtn.classList.toggle('running', running);
  els.toggleBtn.querySelector('use').setAttribute('href', running ? '#icon-stop' : '#icon-play');
  els.toggleLabel.textContent = running ? '停止抓取' : '开始抓取';
  els.progressBar.classList.toggle('indeterminate', running && stats.total === 0);
  if (!running) els.progressBar.classList.remove('indeterminate');
  for (const input of [els.rangeFrom, els.rangeTo]) input.disabled = running;
  for (const chip of [els.rangeWeek, els.rangeClear]) chip.disabled = running;
  updateStatus();
}

function updateRing() {
  const percent = running && stats.total > 0 ? stats.processed / stats.total : running ? 0.08 : 1;
  els.ringValue.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, percent))));
  els.ringCount.textContent = String(liveCount);
}

function updateCycleUI() {
  els.cycleBadge.textContent = `周期 ${cycle.number || 1}`;
  els.cycleCount.textContent = String(liveCount);
  els.cycleAmount.textContent = formatMoney(liveAmount);
  els.cycleFrom.textContent = cycle.fetchFrom ? `起始：${cycle.fetchFrom}` : '起始：首次抓取时确定';
  updateRing();
}

function updateStatsUI() {
  els.statFetched.textContent = String(stats.fetched || 0);
  els.statDup.textContent = String(stats.duplicates || 0);
  els.statFail.textContent = String(stats.failed || 0);
  els.statScan.textContent = String(stats.processed || 0);
  els.statScanTotal.textContent = `/ ${stats.total || 0}`;
}

function updateProgress() {
  if (!running) {
    els.progressLabel.textContent = '准备就绪';
    els.progressPct.textContent = '—';
    els.progressBar.style.width = '0%';
    els.progressBar.classList.remove('indeterminate');
    els.footerStatus.textContent = '本地运行 · 数据仅保存在这台 Mac';
    return;
  }
  if (stats.total > 0) {
    const percent = Math.min(100, Math.round((stats.processed / stats.total) * 100));
    els.progressBar.classList.remove('indeterminate');
    els.progressBar.style.width = `${percent}%`;
    els.progressPct.textContent = `${percent}%`;
    els.progressLabel.textContent = stats.subject ? `正在扫描：${stats.subject}` : '正在扫描邮件…';
  } else {
    els.progressBar.classList.add('indeterminate');
    els.progressBar.style.width = '';
    els.progressPct.textContent = '连接中';
    els.progressLabel.textContent = '正在连接邮箱并读取邮件列表…';
  }
  els.footerStatus.textContent = stats.subject
    ? `正在处理：${stats.subject}`
    : '正在抓取发票…';
}

/* ------------------------------ 事件 ------------------------------ */

function bindEvents() {
  els.toggleBtn.addEventListener('click', toggleFetch);

  els.rangeWeek.addEventListener('click', () => applyQuickRange(7));
  els.rangeClear.addEventListener('click', clearRange);
  els.rangeFrom.addEventListener('change', () => {
    if (els.rangeFrom.value && !els.rangeTo.value) els.rangeTo.value = els.rangeFrom.value;
  });

  els.settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await persistSettings(true);
  });

  els.testBtn.addEventListener('click', async () => {
    const data = validateForm(true);
    if (!data) return;
    const previous = els.testBtn.textContent;
    els.testBtn.disabled = true;
    els.testBtn.textContent = '连接中…';
    try {
      const result = await window.api.testConnection({
        config: data,
        password: els.password.value || undefined,
      });
      if (result.ok) toast(result.message || '连接成功', 'success', 5000);
      else toast(result.error || '连接失败', 'error', 6000);
    } catch (error) {
      toast(error.message || '连接失败', 'error');
    } finally {
      els.testBtn.disabled = false;
      els.testBtn.textContent = previous;
    }
  });

  els.togglePw.addEventListener('click', () => {
    const showing = els.password.type === 'text';
    els.password.type = showing ? 'password' : 'text';
    els.togglePw.querySelector('use').setAttribute('href', showing ? '#icon-eye' : '#icon-eye-off');
  });

  $$('#protocol button').forEach((button) => {
    button.addEventListener('click', () => {
      protocol = button.dataset.value;
      $$('#protocol button').forEach((item) => item.classList.toggle('active', item === button));
      els.mailboxField.style.display = protocol === 'pop3' ? 'none' : '';
      if (provider !== 'custom' && PRESETS[provider]) {
        const preset = PRESETS[provider][protocol];
        els.host.value = preset.host;
        els.port.value = preset.port;
      } else if (!els.port.value || [993, 995].includes(Number(els.port.value))) {
        els.port.value = protocol === 'imap' ? 993 : 995;
      }
    });
  });

  els.provider.addEventListener('change', () => {
    provider = els.provider.value;
    if (provider !== 'custom' && PRESETS[provider]) {
      const preset = PRESETS[provider][protocol];
      els.host.value = preset.host;
      els.port.value = preset.port;
    }
  });

  els.autoScroll.addEventListener('change', () => {
    autoscroll = els.autoScroll.checked;
    if (autoscroll) els.logs.scrollTop = els.logs.scrollHeight;
  });

  els.clearLogs.addEventListener('click', clearLogs);

  els.openTableBtn.addEventListener('click', () => openTarget('excel'));
  els.openTableBtn2.addEventListener('click', () => openTarget('excel'));
  els.openFolderBtn.addEventListener('click', () => openTarget('saveDir'));

  els.changeDirBtn.addEventListener('click', async () => {
    const result = await window.api.chooseDir();
    if (result && result.ok) {
      config = result.config;
      els.saveDirPath.textContent = result.config.saveDir;
      els.saveDirPath.title = result.config.saveDir;
      toast('保存位置已更新', 'success');
    }
  });

  els.newCycleBtn.addEventListener('click', () => {
    const message = `当前共有 ${liveCount} 张发票，累计 ${formatMoney(liveAmount)}。\n\n确认后将删除这些发票文件、清空桌面总览表，并重置去重记录。邮箱设置会保留。`;
    showModal(message);
  });

  els.modalCancel.addEventListener('click', () => hideModal(false));
  els.modalConfirm.addEventListener('click', () => hideModal(true));
  els.modal.addEventListener('click', (event) => {
    if (event.target === els.modal) hideModal(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.modal.classList.contains('hidden')) hideModal(false);
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      toggleFetch();
    }
  });
}

function toDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function applyQuickRange(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  els.rangeFrom.value = toDateInput(start);
  els.rangeTo.value = toDateInput(end);
}

function clearRange() {
  els.rangeFrom.value = '';
  els.rangeTo.value = '';
}

function readRange() {
  const from = els.rangeFrom.value;
  const to = els.rangeTo.value;
  if (!from && !to) return { from: '', to: '' };
  if (!from || !to) return { error: '请同时选择起始日期和结束日期。' };
  if (from > to) return { error: '起始日期不能晚于结束日期。' };
  return { from, to };
}

async function toggleFetch() {
  if (busy) return;
  if (running) {
    busy = true;
    els.toggleBtn.disabled = true;
    els.toggleLabel.textContent = '正在停止…';
    try {
      await window.api.stop();
    } finally {
      els.toggleBtn.disabled = false;
      busy = false;
    }
    return;
  }

  const saved = await persistSettings(false);
  if (!saved) return;
  const range = readRange();
  if (range.error) {
    toast(range.error, 'error');
    return;
  }
  busy = true;
  els.toggleBtn.disabled = true;
  try {
    stats = { total: 0, processed: 0, fetched: 0, duplicates: 0, failed: 0, subject: '' };
    updateStatsUI();
    const result = await window.api.start(range.from ? { from: range.from, to: range.to } : {});
    if (!result.ok) {
      toast(result.error || '无法开始抓取', 'error');
      addLog({ level: 'error', text: result.error || '无法开始抓取', time: Date.now() });
      return;
    }
    setRunningUI(true);
    updateProgress();
    updateRing();
  } finally {
    els.toggleBtn.disabled = false;
    busy = false;
  }
}

async function openTarget(target) {
  const result = await window.api.open(target);
  if (result && !result.ok) toast(result.error || '打开失败', 'error');
}

function showModal(message) {
  els.modalText.textContent = message;
  els.modal.classList.remove('hidden');
}

function hideModal(confirmed) {
  els.modal.classList.add('hidden');
  if (confirmed) runNewCycle();
}

async function runNewCycle() {
  const result = await window.api.resetCycle();
  if (!result || !result.ok) {
    toast((result && result.error) || '操作失败', 'error');
    return;
  }
  cycle = result.cycle;
  liveCount = 0;
  liveAmount = 0;
  clearRange();
  stats = { total: 0, processed: 0, fetched: 0, duplicates: 0, failed: 0, subject: '' };
  updateCycleUI();
  updateStatsUI();
  setRunningUI(false);
  updateProgress();
  toast(`第 ${cycle.number} 个周期已开启`, 'success');
}

/* ------------------------------ 初始化 ------------------------------ */

async function init() {
  if (window.api && window.api.platform === 'win32') document.body.classList.add('win32');
  cacheEls();
  autoscroll = els.autoScroll.checked;
  bindEvents();

  try {
    const boot = await window.api.bootstrap();
    applyConfig(boot.config);
    cycle = boot.cycle || cycle;
    liveCount = cycle.count || 0;
    liveAmount = cycle.totalAmount || 0;
    els.excelPath.textContent = boot.paths.excel;
    els.excelPath.title = boot.paths.excel;
    els.versionText.textContent = `v${boot.version || '1.0.0'}`;
    if (boot.running && boot.stats) {
      stats = { ...stats, ...boot.stats };
      setRunningUI(true);
    }
    updateCycleUI();
    updateStatsUI();
    updateProgress();
    updateStatus();

    window.api.onLog(addLog);
    window.api.onState((payload) => {
      stats = { ...stats, ...payload };
      setRunningUI(Boolean(payload.running));
      updateStatsUI();
      updateProgress();
      updateRing();
    });
    window.api.onInvoice((invoice) => {
      liveCount += 1;
      liveAmount += Number(invoice.amount) || 0;
      stats.fetched = (stats.fetched || 0) + 1;
      updateCycleUI();
      updateStatsUI();
    });
    window.api.onCycle((payload) => {
      cycle = payload.cycle;
      liveCount = 0;
      liveAmount = 0;
      updateCycleUI();
      updateStatsUI();
      if (payload.paths) {
        els.excelPath.textContent = payload.paths.excel;
        els.excelPath.title = payload.paths.excel;
      }
    });
    window.api.onSettings((payload) => {
      if (payload && payload.config) applyConfig(payload.config);
    });

    addLog({
      level: 'info',
      text: '欢迎使用发票捕手。填写邮箱信息并保存后，点击「开始抓取」即可把 PDF 发票汇总到桌面。',
      time: Date.now(),
    });
    if (!hasPassword) {
      addLog({ level: 'muted', text: '提示：网易（yeah.net / 163 / 126）、QQ 等邮箱请填写网页版设置中生成的「客户端授权码」，不是登录密码。', time: Date.now() });
    }
  } catch (error) {
    addLog({ level: 'error', text: `初始化失败：${error.message}`, time: Date.now() });
    toast(`初始化失败：${error.message}`, 'error', 8000);
  }
}

document.addEventListener('DOMContentLoaded', init);
