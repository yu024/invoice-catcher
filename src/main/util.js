'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 本地时间 YYYY-MM-DD */
function formatDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDateTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${formatDate(d)} ${hh}:${mm}`;
}

function shortHash(text, length = 8) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, length);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 去掉文件名里的非法字符 */
function safeFileName(name, fallback = '发票') {
  let out = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (process.platform === 'win32') {
    out = out.replace(/[. ]+$/g, '').trim();
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(out)) out = `_${out}`;
  }
  if (!out) out = fallback;
  if (out.length > 90) out = out.slice(0, 90).trim();
  return out;
}

/** 在目录内生成不冲突的文件名 */
function uniquePath(dir, fileName) {
  const ext = path.extname(fileName) || '.pdf';
  const base = path.basename(fileName, ext);
  let candidate = path.join(dir, `${base}${ext}`);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${i}${ext}`);
    i += 1;
  }
  return candidate;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写入，避免中途崩溃留下半个 JSON */
function writeJSON(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function friendlyError(err) {
  const raw = String((err && (err.responseText || err.message)) || err || '未知错误');
  if (/AUTHENTICATIONFAILED|authentication failed|invalid credentials|login failed|AUTH\b|用户名或密码|authorization/i.test(raw)) {
    return '登录失败：账号或授权码不正确。QQ / 163 / 126 等邮箱需要在网页版开启 IMAP/POP3 并使用「授权码」，而不是登录密码。';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return '无法找到邮件服务器，请检查主机地址是否正确。';
  if (/ECONNREFUSED/i.test(raw)) return '服务器拒绝连接，请检查端口号以及是否已开启 IMAP / POP3 服务。';
  if (/ETIMEDOUT|timeout|timed out/i.test(raw)) return '连接超时，请检查网络或更换端口后重试。';
  if (/certificate|self[- ]signed|SSL|TLS/i.test(raw)) return 'TLS 加密握手失败，请确认端口与「SSL/TLS」开关是否匹配。';
  if (/Unsafe Login|ID required/i.test(raw)) return '邮箱服务器要求客户端身份标识（ID），请在邮箱设置中开启 IMAP 服务后重试。';
  return raw;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  formatDate,
  formatDateTime,
  shortHash,
  sha256,
  safeFileName,
  uniquePath,
  ensureDir,
  readJSON,
  writeJSON,
  friendlyError,
  sleep,
};
