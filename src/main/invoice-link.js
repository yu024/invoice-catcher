'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BrowserWindow, session } = require('electron');

/** 目前支持「邮件里给链接、PDF 在网页上」的开票平台域名。 */
const SUPPORTED_HOSTS = ['nuonuo.com', 'jss.com.cn', 'baiwang.com', 'piaozone.com'];

function parseUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function isSupportedInvoiceLink(value) {
  const url = parseUrl(value);
  if (!url) return false;
  return SUPPORTED_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

function scoreLink(value) {
  const url = parseUrl(value);
  if (!url) return -100;
  const host = url.hostname;
  const pathName = url.pathname || '/';
  let score = 0;
  if (/^nnfp\./.test(host)) score += 6;
  if (/^(fp|inv|dzfp|d)\./.test(host)) score += 2;
  if (/invoice|scan|fapiao/i.test(host) || /invoice|scan|fapiao/i.test(pathName)) score += 3;
  if (/^\/[A-Za-z0-9_-]{8,}$/.test(pathName)) score += 4;
  if (/about|home|help|download|app|product|contact|login|register/i.test(pathName)) score -= 10;
  if (url.hash && pathName === '/') score -= 4;
  return score;
}

/** 从邮件正文里挑出最像「发票下载页」的链接（去重，按可信度排序）。 */
function extractInvoiceLinks(parsed, limit = 2) {
  const found = new Map();
  const push = (value) => {
    const text = String(value || '').replace(/&amp;/g, '&').trim();
    if (!isSupportedInvoiceLink(text) || found.has(text)) return;
    found.set(text, scoreLink(text));
  };

  const html = String((parsed && parsed.html) || '');
  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) push(match[1]);
  for (const match of html.matchAll(/https?:\/\/[^\s"'<>]+/gi)) push(match[0]);

  const text = String((parsed && parsed.text) || '');
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+/gi)) push(match[0]);

  return [...found.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([link]) => link);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CLICK_SCRIPT = (label) => `(() => {
  const target = ${JSON.stringify(label)};
  const nodes = [...document.querySelectorAll('button, a, div, span')];
  const hit = nodes.find((node) => {
    const text = (node.innerText || '').replace(/\\s+/g, '');
    if (text !== target) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  if (!hit) return false;
  hit.click();
  return true;
})()`;

async function pageHasButton(win, label) {
  try {
    return await win.webContents.executeJavaScript(
      `(() => [...document.querySelectorAll('button, a, div, span')].some((n) => (n.innerText || '').replace(/\\s+/g, '') === ${JSON.stringify(
        label
      )}))()`,
      true
    );
  } catch {
    return false;
  }
}

/**
 * 打开发票网页，依次尝试下载 XML（用于精确解析字段）和 PDF。
 * 返回 { pdf: {buffer,fileName}|null, xml: {text,fileName}|null }。
 */
async function downloadInvoiceFiles(url, { timeout = 90000, log = () => {} } = {}) {
  if (!isSupportedInvoiceLink(url)) throw new Error('暂不支持该发票链接');

  const partition = `invoice-link-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ses = session.fromPartition(partition);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-link-'));
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 960,
    webPreferences: { session: ses, sandbox: true, images: false, backgroundThrottling: false },
  });

  const downloads = [];
  let waiter = null;

  ses.on('will-download', (event, item) => {
    const fileName = (item.getFilename() || 'invoice').replace(/[\\/:*?"<>|]/g, '_');
    const target = path.join(workDir, fileName);
    item.setSavePath(target);
    const entry = { fileName, target, done: null };
    entry.done = new Promise((resolve) => {
      item.once('done', (_event, state) => {
        entry.state = state;
        resolve(state === 'completed' ? entry : null);
      });
    });
    downloads.push(entry);
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(entry.done);
    }
  });

  function resolveWaiter(value) {
    if (!waiter) return;
    const resolve = waiter;
    waiter = null;
    resolve(value);
  }

  function waitDownload(ms) {
    return Promise.race([
      new Promise((resolve) => {
        waiter = resolve;
      }),
      sleep(ms).then(() => null),
    ]);
  }

  async function clickAndWait(label) {
    const pending = waitDownload(20000);
    const clicked = await win.webContents.executeJavaScript(CLICK_SCRIPT(label), true).catch(() => false);
    if (!clicked) {
      resolveWaiter(null);
      await pending;
      return null;
    }
    return pending;
  }

  try {
    win.loadURL(url).catch(() => {
      /* 链接直接下载时导航会被中止 */
    });

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (downloads.length) break;
      if (await pageHasButton(win, '下载PDF文件')) break;
      await sleep(1200);
    }

    let xml = null;
    let pdf = null;

    if (await pageHasButton(win, '下载XML文件')) {
      const entry = await clickAndWait('下载XML文件');
      if (entry) {
        const text = fs.readFileSync(entry.target, 'utf8');
        xml = { text, fileName: entry.fileName };
        log(`已获取发票 XML：${entry.fileName}`);
      }
    }

    const existingPdf = downloads.find((entry) => /\.pdf$/i.test(entry.fileName));
    if (existingPdf) {
      const entry = await existingPdf.done;
      if (entry) pdf = { buffer: fs.readFileSync(entry.target), fileName: entry.fileName };
    } else if (await pageHasButton(win, '下载PDF文件')) {
      const entry = await clickAndWait('下载PDF文件');
      if (entry) {
        pdf = { buffer: fs.readFileSync(entry.target), fileName: entry.fileName };
        log(`已获取发票 PDF：${entry.fileName}`);
      }
    }

    if (!pdf && !xml) throw new Error('页面上没有找到发票下载按钮');
    if (pdf && pdf.buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('下载到的文件不是 PDF');
    return { pdf, xml };
  } finally {
    if (!win.isDestroyed()) win.destroy();
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* 临时目录清不掉不影响使用 */
    }
  }
}

module.exports = { downloadInvoiceFiles, extractInvoiceLinks, isSupportedInvoiceLink };
