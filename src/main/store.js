'use strict';

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { ensureDir, readJSON, writeJSON } = require('./util');

const DEFAULTS = {
  email: '',
  protocol: 'imap',
  provider: 'yeah',
  host: 'imap.yeah.net',
  port: 993,
  secure: true,
  mailbox: 'INBOX',
  saveDir: '',
};

const ALLOWED = new Set(Object.keys(DEFAULTS));

function desktopSaveDir() {
  return path.join(app.getPath('desktop'), '发票PDF');
}

function legacySaveDir() {
  return path.join(app.getPath('documents'), '发票捕手', 'PDF发票');
}

function freshCycle(number) {
  return {
    cycle: number,
    startedAt: new Date().toISOString(),
    fetchFrom: '',
    invoices: [],
    seen: [],
    lastUid: {},
  };
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateValue(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

class Store {
  constructor() {
    this.dir = app.getPath('userData');
    ensureDir(this.dir);
    this.configFile = path.join(this.dir, 'config.json');
    this.cycleFile = path.join(this.dir, 'cycle.json');
    this.secretFile = path.join(this.dir, 'secret.bin');

    this.config = { ...DEFAULTS, ...readJSON(this.configFile, {}) };
    this.config.port = Number(this.config.port) || 993;

    const previousSaveDir = this.config.saveDir ? path.resolve(this.config.saveDir) : '';
    const shouldUseDesktop = !previousSaveDir || previousSaveDir === legacySaveDir();
    if (shouldUseDesktop) this.config.saveDir = desktopSaveDir();
    ensureDir(this.config.saveDir);

    this.cycle = readJSON(this.cycleFile, null) || freshCycle(1);
    if (!Array.isArray(this.cycle.invoices)) this.cycle.invoices = [];
    if (!Array.isArray(this.cycle.seen)) this.cycle.seen = [];
    if (!this.cycle.lastUid || typeof this.cycle.lastUid !== 'object') this.cycle.lastUid = {};
    this.seenSet = new Set(this.cycle.seen);
    this.hashSet = new Set(this.cycle.invoices.map((item) => item.hash).filter(Boolean));

    if (shouldUseDesktop) {
      writeJSON(this.configFile, this.config);
      this.migrateFiles(previousSaveDir, this.config.saveDir);
    }
  }

  migrateFiles(fromDir, toDir) {
    if (!fromDir || path.resolve(fromDir) === path.resolve(toDir) || !fs.existsSync(fromDir)) return;
    let moved = 0;
    const mapping = new Map();
    try {
      for (const name of fs.readdirSync(fromDir)) {
        const source = path.join(fromDir, name);
        if (!fs.statSync(source).isFile() || !/\.pdf$/i.test(name)) continue;
        let target = path.join(toDir, name);
        if (fs.existsSync(target)) {
          const ext = path.extname(name);
          target = path.join(toDir, `${path.basename(name, ext)}-${Date.now()}${ext}`);
        }
        try {
          fs.renameSync(source, target);
        } catch (error) {
          fs.copyFileSync(source, target);
          fs.unlinkSync(source);
        }
        mapping.set(source, target);
        moved += 1;
      }
    } catch (error) {
      console.error('迁移发票文件失败', error);
    }

    if (mapping.size) {
      for (const invoice of this.cycle.invoices) {
        const next = mapping.get(invoice.savedPath);
        if (next) {
          invoice.savedPath = next;
          invoice.fileName = path.basename(next);
        }
      }
      writeJSON(this.cycleFile, this.cycle);
    }
    if (moved) console.log(`已将 ${moved} 个发票文件迁移到 ${toDir}`);
    try {
      if (fs.existsSync(fromDir) && fs.readdirSync(fromDir).length === 0) fs.rmdirSync(fromDir);
      const parent = path.dirname(fromDir);
      if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
    } catch (error) {
      /* 旧目录清不掉不影响使用 */
    }
  }

  /* ------------------------------ 设置 ------------------------------ */

  getConfig() {
    return { ...this.config };
  }

  getPublicConfig() {
    return { ...this.config, hasPassword: this.hasPassword() };
  }

  saveSettings(patch = {}) {
    const next = { ...this.config };
    for (const [key, value] of Object.entries(patch)) {
      if (!ALLOWED.has(key)) continue;
      if (key === 'port') {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口号必须是 1-65535 之间的数字');
        next.port = port;
      } else if (key === 'secure') {
        next.secure = Boolean(value);
      } else if (key === 'protocol') {
        next.protocol = value === 'pop3' ? 'pop3' : 'imap';
      } else {
        next[key] = String(value == null ? '' : value).trim();
      }
    }
    if (!next.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) {
      throw new Error('请填写有效的邮箱地址');
    }
    if (!next.host) throw new Error('请填写邮件服务器地址');
    if (!next.mailbox) next.mailbox = 'INBOX';
    next.saveDir = path.resolve(next.saveDir || desktopSaveDir());
    ensureDir(next.saveDir);
    this.config = next;
    writeJSON(this.configFile, next);
    return this.getPublicConfig();
  }

  setSaveDir(dir) {
    if (!dir) return this.getPublicConfig();
    this.config.saveDir = path.resolve(dir);
    ensureDir(this.config.saveDir);
    writeJSON(this.configFile, this.config);
    return this.getPublicConfig();
  }

  hasPassword() {
    try {
      return fs.statSync(this.secretFile).size > 4;
    } catch {
      return false;
    }
  }

  setPassword(password) {
    if (typeof password !== 'string' || password.length === 0) return false;
    let buf;
    if (safeStorage.isEncryptionAvailable()) {
      buf = Buffer.concat([Buffer.from('ENC1'), safeStorage.encryptString(password)]);
    } else {
      buf = Buffer.concat([Buffer.from('PLN1'), Buffer.from(password, 'utf8')]);
    }
    fs.writeFileSync(this.secretFile, buf, { mode: 0o600 });
    return true;
  }

  getPassword() {
    try {
      const buf = fs.readFileSync(this.secretFile);
      const tag = buf.subarray(0, 4).toString('utf8');
      if (tag === 'ENC1' && safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(buf.subarray(4));
      }
      if (tag === 'PLN1') return buf.subarray(4).toString('utf8');
    } catch {
      /* ignore */
    }
    return '';
  }

  /* ------------------------------ 周期 ------------------------------ */

  getExcelPath() {
    return path.join(app.getPath('desktop'), '发票总览.xlsx');
  }

  getCycleSummary() {
    const invoices = this.cycle.invoices || [];
    const totalAmount = invoices.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
    return {
      number: this.cycle.cycle,
      startedAt: this.cycle.startedAt,
      fetchFrom: this.cycle.fetchFrom || '',
      count: invoices.length,
      totalAmount: Math.round(totalAmount * 100) / 100,
    };
  }

  getInvoices() {
    return this.cycle.invoices.slice();
  }

  getFetchFrom() {
    return this.cycle.fetchFrom || '';
  }

  /**
   * 固定本周期起始抓取日：只在本周期还没有起始日时写入。
   * 返回最终的 YYYY-MM-DD。
   */
  ensureFetchFrom(dateStr = localDateString()) {
    if (!this.cycle.fetchFrom) {
      this.cycle.fetchFrom = String(dateStr).slice(0, 10);
      this.saveCycle();
    }
    return this.cycle.fetchFrom;
  }

  /**
   * 删除超过保留天数的发票记录与对应 PDF，返回清理结果。
   */
  cleanupExpired(days = 30, now = new Date()) {
    const cutoff = new Date(now.getTime());
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - days);

    const saveRoot = path.resolve(this.config.saveDir) + path.sep;
    const removed = [];
    const kept = [];

    for (const invoice of this.cycle.invoices) {
      // 保留期按「抓取时间」计算：补抓的历史发票也能完整保留 30 天
      const effective =
        parseDateValue(invoice.fetchedAt) ||
        parseDateValue(invoice.mailDate) ||
        parseDateValue(invoice.invoiceDate && invoice.invoiceDate.length === 10 ? `${invoice.invoiceDate}T00:00:00` : invoice.invoiceDate);
      if (!effective || effective.getTime() >= cutoff.getTime()) {
        kept.push(invoice);
        continue;
      }
      removed.push(invoice);
      if (invoice.savedPath) {
        const resolved = path.resolve(invoice.savedPath);
        if (resolved.startsWith(saveRoot)) {
          try {
            fs.unlinkSync(resolved);
          } catch {
            /* 文件可能已被移走 */
          }
        }
      }
      if (invoice.hash) this.hashSet.delete(invoice.hash);
    }

    if (removed.length > 0) {
      this.cycle.invoices = kept;
      this.saveCycle();
    }

    return {
      removedCount: removed.length,
      keptCount: kept.length,
      cutoff: localDateString(cutoff),
      removed: removed.map((item) => ({
        fileName: item.fileName || '',
        savedPath: item.savedPath || '',
        date: item.invoiceDate || item.mailDate || item.fetchedAt || '',
      })),
    };
  }

  isMessageSeen(key) {
    return this.seenSet.has(key);
  }

  markMessageSeen(key) {
    if (!key || this.seenSet.has(key)) return;
    this.seenSet.add(key);
    this.cycle.seen.push(key);
  }

  hasInvoiceHash(hash) {
    return this.hashSet.has(hash);
  }

  addInvoice(record) {
    if (record.hash && this.hashSet.has(record.hash)) return false;
    this.cycle.invoices.push(record);
    if (record.hash) this.hashSet.add(record.hash);
    this.saveCycle();
    return true;
  }

  getLastUid(key) {
    return this.cycle.lastUid[key] || null;
  }

  setLastUid(key, validity, uid) {
    this.cycle.lastUid[key] = { validity: String(validity), uid: Number(uid) };
  }

  saveCycle() {
    writeJSON(this.cycleFile, this.cycle);
  }

  /**
   * 开始新周期：清空发票记录、去重记录、增量游标，并删除本周期下载的 PDF。
   * 只删除记录在案的发票文件，避免误删用户自己放进目录的文件。
   */
  resetCycle() {
    const previous = this.cycle;
    for (const invoice of previous.invoices) {
      if (!invoice.savedPath) continue;
      const resolved = path.resolve(invoice.savedPath);
      if (resolved.startsWith(path.resolve(this.config.saveDir) + path.sep)) {
        try {
          fs.unlinkSync(resolved);
        } catch {
          /* 文件可能已被移动或删除 */
        }
      }
    }
    try {
      const leftovers = fs.readdirSync(this.config.saveDir);
      if (leftovers.length === 0) fs.rmdirSync(this.config.saveDir);
    } catch {
      /* ignore */
    }
    ensureDir(this.config.saveDir);
    this.cycle = freshCycle((previous.cycle || 0) + 1);
    this.seenSet = new Set();
    this.hashSet = new Set();
    this.saveCycle();
    return this.getCycleSummary();
  }
}

module.exports = { Store, DEFAULTS };
