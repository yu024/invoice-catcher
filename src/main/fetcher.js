'use strict';

const fs = require('fs');
const path = require('path');
const { simpleParser } = require('mailparser');
const { ImapFlow } = require('imapflow');
const Pop3Client = require('./pop3');
const { extractInvoiceMeta, parseInvoiceXml, classifyInvoice, isItineraryAttachment } = require('./invoice');
const { downloadInvoiceFiles, extractInvoiceLinks } = require('./invoice-link');
const {
  formatDate,
  sha256,
  safeFileName,
  uniquePath,
  ensureDir,
  friendlyError,
  shortHash,
} = require('./util');

const MAX_RANGE_DAYS = { imap: 366, pop3: 90 };
const DAY_MS = 24 * 60 * 60 * 1000;

function parseLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 校验并收敛手动区间：返回 { from, to, start, end, clamped, days } 或 { error } */
function clampRange(protocol, fromValue, toValue) {
  const from = parseLocalDate(fromValue);
  const to = parseLocalDate(toValue);
  if (!from || !to) return { error: '请同时选择起始日期和结束日期。' };
  if (from.getTime() > to.getTime()) return { error: '起始日期不能晚于结束日期。' };
  const days = Math.floor((to.getTime() - from.getTime()) / DAY_MS) + 1;
  const max = MAX_RANGE_DAYS[protocol === 'pop3' ? 'pop3' : 'imap'];
  if (days > max) {
    const clampedFrom = new Date(to.getTime() - (max - 1) * DAY_MS);
    return {
      from: formatLocalDate(clampedFrom),
      to: formatLocalDate(to),
      start: clampedFrom,
      end: new Date(to.getTime() + DAY_MS),
      clamped: true,
      days: max,
      max,
    };
  }
  return {
    from: formatLocalDate(from),
    to: formatLocalDate(to),
    start: from,
    end: new Date(to.getTime() + DAY_MS),
    clamped: false,
    days,
    max,
  };
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const INVOICE_SUBJECT = /发票|数电票|电子发票|invoice|fapiao/i;
const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024;

function isPdfBuffer(buffer) {
  if (!buffer || buffer.length < 5) return false;
  const head = buffer.subarray(0, 1024).toString('latin1');
  return head.includes('%PDF-');
}

function isPdfAttachment(attachment) {
  if (!attachment || !attachment.content || !attachment.content.length) return false;
  if (/\.pdf$/i.test(attachment.filename || '')) return true;
  if (String(attachment.contentType || '').toLowerCase() === 'application/pdf') return true;
  return isPdfBuffer(attachment.content);
}

function collectParts(node, result = { pdfs: [], attachments: 0 }) {
  if (!node) return result;
  const type = String(node.type || '').toLowerCase();
  const fileName =
    (node.dispositionParameters && node.dispositionParameters.filename) ||
    (node.parameters && node.parameters.name) ||
    '';
  if (node.disposition === 'attachment' || fileName) result.attachments += 1;
  if (type === 'application/pdf' || /\.pdf/i.test(fileName)) result.pdfs.push(node);
  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) collectParts(child, result);
  }
  return result;
}

function formatSender(list) {
  if (!Array.isArray(list)) return '';
  return list
    .map((item) => (item && (item.name || item.address)) || '')
    .filter(Boolean)
    .join(', ');
}

class Fetcher {
  constructor({ store, excel, emit }) {
    this.store = store;
    this.excel = excel;
    this.emit = emit;
    this.running = false;
    this.stopRequested = false;
    this.client = null;
    this.stats = null;
    this.finished = null;
  }

  log(level, text) {
    this.emit('fetch:log', { time: Date.now(), level, text });
  }

  broadcastState(phase = 'scanning') {
    if (!this.stats) return;
    this.emit('fetch:state', { running: this.running, phase, ...this.stats });
  }

  start(options = {}) {
    if (this.running) return { ok: false, error: '正在抓取中，请先停止。' };
    const config = this.store.getConfig();
    const password = this.store.getPassword();
    if (!config.email) return { ok: false, error: '请先在右侧填写邮箱账号。' };
    if (!password) return { ok: false, error: '请填写邮箱密码或授权码。' };
    if (!config.host) return { ok: false, error: '请填写邮件服务器地址。' };

    const manual = options && (options.from || options.to);
    if (manual) {
      const range = clampRange(config.protocol, options.from, options.to);
      if (range.error) return { ok: false, error: range.error };
      this.manualRange = { from: range.from, to: range.to, clamped: range.clamped, max: range.max };
      this.fetchFrom = range.from;
      this.fetchFromDate = range.start;
      this.fetchToDate = range.end;
    } else {
      // 本周期只在第一次点击时固定起始日，之后一直沿用
      this.manualRange = null;
      const fetchFrom = this.store.getFetchFrom() || this.store.ensureFetchFrom(localDateString());
      this.fetchFrom = fetchFrom;
      const startOfDay = new Date(`${fetchFrom}T00:00:00`);
      this.fetchFromDate = Number.isNaN(startOfDay.getTime()) ? null : startOfDay;
      this.fetchToDate = null;
    }

    this.running = true;
    this.stopRequested = false;
    this.stats = { total: 0, processed: 0, fetched: 0, duplicates: 0, failed: 0, subject: '' };
    this.broadcastState('connecting');
    this.finished = this._run(config, password)
      .catch((error) => {
        this.log('error', friendlyError(error));
      })
      .finally(() => {
        this.running = false;
        this.client = null;
        this.broadcastState('idle');
        this.excel.flush();
      });
    return { ok: true };
  }

  async stop() {
    if (!this.running) return { ok: true };
    this.stopRequested = true;
    this.log('warn', '正在停止抓取…');
    try {
      if (this.client && typeof this.client.close === 'function') this.client.close();
    } catch {
      /* ignore */
    }
    if (this.finished) {
      await Promise.race([this.finished, new Promise((resolve) => setTimeout(resolve, 4000))]);
    }
    return { ok: true };
  }

  async _run(config, password) {
    this.log('info', `开始抓取 · ${String(config.protocol).toUpperCase()} · ${config.email}`);
    if (this.manualRange) {
      const suffix = this.manualRange.clamped ? `（超出上限，已自动收敛到 ${this.manualRange.max} 天内）` : '';
      this.log('info', `本次为手动区间：${this.manualRange.from} ~ ${this.manualRange.to}${suffix}`);
    } else if (this.fetchFrom) {
      this.log('info', `本周期起始日：${this.fetchFrom}，仅抓取该日期及以后的邮件。`);
    }
    try {
      if (config.protocol === 'pop3') await this._runPop3(config, password);
      else await this._runImap(config, password);
      if (this.stopRequested) {
        this.log('warn', `已停止。本次新增 ${this.stats.fetched} 张发票。`);
      } else {
        this.log(
          'success',
          `抓取完成：新增 ${this.stats.fetched} 张发票，跳过重复 ${this.stats.duplicates} 条，失败 ${this.stats.failed} 条。`,
        );
      }
    } catch (error) {
      if (this.stopRequested) this.log('warn', '已停止抓取。');
      else throw error;
    } finally {
      this._cleanupExpired();
      await this.excel.flush();
    }
  }

  _cleanupExpired() {
    if (!this.store || typeof this.store.cleanupExpired !== 'function') return;
    try {
      const result = this.store.cleanupExpired(30);
      if (result.removedCount > 0) {
        this.log('info', `已清理 ${result.removedCount} 张超过 30 天的发票（截止 ${result.cutoff}）。`);
        this.excel.request();
      }
    } catch (error) {
      this.log('warn', `清理过期发票失败：${friendlyError(error)}`);
    }
  }

  async _runImap(config, password) {
    const client = new ImapFlow({
      host: config.host,
      port: Number(config.port) || 993,
      secure: config.secure !== false,
      auth: { user: config.email, pass: password },
      logger: false,
      clientInfo: { name: '发票捕手', version: '1.0.0', vendor: 'InvoiceCatcher' },
      tls: { minVersion: 'TLSv1.2' },
      connectionTimeout: 30000,
      greetingTimeout: 30000,
      socketTimeout: 180000,
    });
    this.client = client;
    client.on('error', (error) => {
      if (!this.stopRequested) this.log('warn', `IMAP 连接提示：${error.message}`);
    });

    this.log('info', `连接 ${config.host}:${config.port}（IMAP）…`);
    await client.connect();
    this.log('success', `已连接 ${config.email}`);

    const mailbox = config.mailbox || 'INBOX';
    const lock = await client.getMailboxLock(mailbox);
    try {
      const info = client.mailbox || {};
      const key = `imap|${config.email}|${config.host}|${mailbox}`;
      const validity = String(info.uidValidity || '');
      const last = this.store.getLastUid(key);
      const canResume = last && String(last.validity) === validity && Number(last.uid) > 0;
      const since = this.fetchFromDate;
      const before = this.fetchToDate;
      const dateQuery = { ...(since ? { since } : {}), ...(before ? { before } : {}) };
      const useResume = canResume && !this.manualRange;
      let uids;
      if (useResume) {
        uids = await client.search({ uid: `${Number(last.uid) + 1}:*`, ...dateQuery }, { uid: true });
      } else if (since || before) {
        uids = await client.search(dateQuery, { uid: true });
      } else {
        uids = await client.search({ all: true }, { uid: true });
      }
      uids = Array.from(new Set(uids))
        .filter((uid) => Number(uid) > 0)
        .sort((a, b) => b - a);

      if (useResume) {
        this.log('info', `增量扫描：上次处理到 UID ${last.uid}，本次待扫描 ${uids.length} 封。`);
      } else if (this.manualRange) {
        this.log('info', `区间扫描 ${mailbox}：共 ${uids.length} 封邮件。`);
      } else if (since) {
        this.log('info', `扫描 ${mailbox} 中 ${this.fetchFrom} 及以后的邮件：共 ${uids.length} 封。`);
      } else {
        this.log('info', `全量扫描 ${mailbox}：共 ${uids.length} 封邮件。`);
      }
      this.stats.total = uids.length;
      this.broadcastState();

      let maxUid = Number(useResume ? last.uid : 0);

      for (const uid of uids) {
        if (this.stopRequested) break;
        try {
          const msg = await client.fetchOne(
            uid,
            { envelope: true, bodyStructure: true, size: true },
            { uid: true },
          );
          this.stats.processed += 1;
          if (!msg) {
            this.broadcastState();
            continue;
          }
          const envelope = msg.envelope || {};
          const messageDate = envelope.date ? new Date(envelope.date) : null;
          if (
            messageDate &&
            ((this.fetchFromDate && messageDate < this.fetchFromDate) ||
              (this.fetchToDate && messageDate >= this.fetchToDate))
          ) {
            this.store.markMessageSeen(`imap|${config.email}|${mailbox}|${envelope.messageId || this._fallbackKey(envelope, msg.size)}`);
            this.broadcastState();
            continue;
          }
          const subject = envelope.subject || '';
          this.stats.subject = subject.slice(0, 64);
          const messageId = envelope.messageId || '';
          const messageKey = `imap|${config.email}|${mailbox}|${
            messageId || this._fallbackKey(envelope, msg.size)
          }`;
          if (this.store.isMessageSeen(messageKey)) {
            this.stats.duplicates += 1;
            this.broadcastState();
            continue;
          }

          const parts = collectParts(msg.bodyStructure);
          const mightBeInvoice = parts.pdfs.length > 0 || INVOICE_SUBJECT.test(subject);
          if (!mightBeInvoice) {
            this.store.markMessageSeen(messageKey);
            this.broadcastState();
            continue;
          }

          const full = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!full || !full.source) {
            this.stats.failed += 1;
            this.log('warn', `无法读取邮件内容：${subject || `UID ${uid}`}`);
            this.broadcastState();
            continue;
          }
          const parsed = await simpleParser(full.source);
          const pdfAttachments = (parsed.attachments || []).filter(isPdfAttachment).filter((item) => {
            if (isItineraryAttachment(item.filename)) {
              this.log('muted', `已忽略行程单（不作为发票）：${item.filename}`);
              return false;
            }
            return true;
          });
          if (pdfAttachments.length === 0) {
            const linked = await this._downloadLinkedPdfs(parsed, subject);
            if (linked.length === 0) {
              this.store.markMessageSeen(messageKey);
              this.log('muted', `跳过（未发现 PDF 附件或可下载链接）：${subject || '(无主题)'}`);
              this.broadcastState();
              continue;
            }
            pdfAttachments.push(...linked);
          }

          let hadFailure = false;
          for (const attachment of pdfAttachments) {
            if (this.stopRequested) break;
            const result = await this._handleAttachment(attachment, {
              config,
              envelope,
              parsed,
              subject,
            });
            if (result === 'duplicate') this.stats.duplicates += 1;
            else if (result === 'added') this.stats.fetched += 1;
            else if (result === 'failed') {
              this.stats.failed += 1;
              hadFailure = true;
            }
            this.broadcastState();
          }
          if (!hadFailure) {
            this.store.markMessageSeen(messageKey);
            maxUid = Math.max(maxUid, Number(uid));
            this.store.saveCycle();
          }
          this.broadcastState();
        } catch (error) {
          this.stats.failed += 1;
          this.log('error', `处理邮件 UID ${uid} 失败：${friendlyError(error)}`);
          this.broadcastState();
        }
      }

      if (!this.stopRequested && this.stats.failed === 0 && !this.manualRange) {
        const newLast = uids.length ? Math.max(maxUid, ...uids) : maxUid;
        if (newLast > 0) this.store.setLastUid(key, validity, newLast);
        this.store.saveCycle();
      } else if (this.stats.failed > 0) {
        this.log('warn', '部分邮件处理失败，下次会重新扫描（已保存的发票不会重复下载）。');
      }
    } finally {
      try {
        lock.release();
      } catch {
        /* ignore */
      }
      try {
        await client.logout();
      } catch {
        try {
          client.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  async _runPop3(config, password) {
    const client = new Pop3Client({
      host: config.host,
      port: Number(config.port) || 995,
      secure: config.secure !== false,
    });
    this.client = client;
    this.log('info', `连接 ${config.host}:${config.port}（POP3）…`);
    await client.connect();
    await client.login(config.email, password);
    this.log('success', `已连接 ${config.email}`);

    const stat = await client.stat();
    const sizes = await client.list();
    const uidl = await client.uidl();
    const indexes = Array.from(uidl.keys()).sort((a, b) => b - a);
    this.stats.total = indexes.length;
    this.log('info', `POP3 邮箱共 ${stat.count} 封邮件，开始扫描。`);
    this.broadcastState();

    try {
      for (const index of indexes) {
        if (this.stopRequested) break;
        this.stats.processed += 1;
        try {
          const uid = uidl.get(index);
          const messageKey = `pop3|${config.email}|${config.host}|${uid}`;
          if (this.store.isMessageSeen(messageKey)) {
            this.stats.duplicates += 1;
            this.broadcastState();
            continue;
          }
          const size = sizes.get(index) || 0;
          if (size > 60 * 1024 * 1024) {
            this.stats.failed += 1;
            this.log('warn', `跳过超大邮件（${(size / 1048576).toFixed(1)} MB）`);
            this.broadcastState();
            continue;
          }
          if (this.fetchFromDate) {
            try {
              const head = await client.top(index, 0);
              const headParsed = await simpleParser(head);
              const headDate = headParsed.date ? new Date(headParsed.date) : null;
              if (headDate && (headDate < this.fetchFromDate || (this.fetchToDate && headDate >= this.fetchToDate))) {
                this.store.markMessageSeen(messageKey);
                this.broadcastState();
                continue;
              }
            } catch {
              /* 部分服务器不支持 TOP，继续按正文日期过滤 */
            }
          }
          const raw = await client.retr(index);
          const parsed = await simpleParser(raw);
          const parsedDate = parsed.date ? new Date(parsed.date) : null;
          if (parsedDate && (parsedDate < this.fetchFromDate || (this.fetchToDate && parsedDate >= this.fetchToDate))) {
            this.store.markMessageSeen(messageKey);
            this.broadcastState();
            continue;
          }
          const subject = parsed.subject || '';
          this.stats.subject = subject.slice(0, 64);
          const pdfAttachments = (parsed.attachments || []).filter(isPdfAttachment).filter((item) => {
            if (isItineraryAttachment(item.filename)) {
              this.log('muted', `已忽略行程单（不作为发票）：${item.filename}`);
              return false;
            }
            return true;
          });
          if (pdfAttachments.length === 0) {
            const linked = await this._downloadLinkedPdfs(parsed, subject);
            if (linked.length === 0) {
              this.store.markMessageSeen(messageKey);
              this.broadcastState();
              continue;
            }
            pdfAttachments.push(...linked);
          }

          let hadFailure = false;
          for (const attachment of pdfAttachments) {
            if (this.stopRequested) break;
            const result = await this._handleAttachment(attachment, {
              config,
              envelope: {
                date: parsed.date,
                from: parsed.from && parsed.from.value,
                messageId: parsed.messageId,
              },
              parsed,
              subject,
            });
            if (result === 'duplicate') this.stats.duplicates += 1;
            else if (result === 'added') this.stats.fetched += 1;
            else if (result === 'failed') {
              this.stats.failed += 1;
              hadFailure = true;
            }
            this.broadcastState();
          }
          if (!hadFailure) {
            this.store.markMessageSeen(messageKey);
            this.store.saveCycle();
          }
          this.broadcastState();
        } catch (error) {
          this.stats.failed += 1;
          this.log('error', `读取第 ${index} 封邮件失败：${friendlyError(error)}`);
          this.broadcastState();
        }
      }
    } finally {
      await client.quit();
    }
  }

  _fallbackKey(envelope, size) {
    return shortHash(
      `${envelope.subject || ''}|${envelope.date ? envelope.date.toISOString() : ''}|${size || 0}|${
        formatSender(envelope.from) || ''
      }`,
      24,
    );
  }

  /** 邮件没有 PDF 附件时，尝试打开正文里的开票平台链接，把 PDF 抓下来。 */
  async _downloadLinkedPdfs(parsed, subject) {
    const links = extractInvoiceLinks(parsed);
    if (!links.length) return [];
    const attachments = [];
    for (const link of links) {
      if (this.stopRequested) break;
      try {
        const host = new URL(link).hostname;
        this.log('info', `邮件内没有 PDF 附件，正在打开发票链接（${host}）…`);
        const { pdf, xml } = await downloadInvoiceFiles(link, {
          log: (message) => this.log('muted', message),
        });
        if (!pdf) {
          this.log('warn', `链接里没有可下载的 PDF（${subject || '无主题'}）`);
          continue;
        }
        attachments.push({
          filename: pdf.fileName,
          contentType: 'application/pdf',
          content: pdf.buffer,
          xmlMeta: xml ? parseInvoiceXml(xml.text) : null,
        });
        this.log('success', `已从链接获取 PDF：${pdf.fileName}`);
        break;
      } catch (error) {
        this.log('warn', `发票链接下载失败（${subject || '无主题'}）：${friendlyError(error)}`);
      }
    }
    return attachments;
  }

  async _handleAttachment(attachment, ctx) {
    const buffer = attachment.content;
    if (!buffer || !buffer.length) return 'failed';
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      this.log('warn', `附件过大，已跳过：${attachment.filename || 'PDF'}`);
      return 'failed';
    }
    if (!isPdfAttachment(attachment)) return 'skip';

    const hash = sha256(buffer);
    if (this.store.hasInvoiceHash(hash)) {
      this.log('muted', `重复发票已跳过：${attachment.filename || 'PDF'}`);
      return 'duplicate';
    }

    let meta = attachment.xmlMeta || null;
    if (!meta || !meta.invoiceNo || meta.amount == null) {
      try {
        const pdfMeta = await extractInvoiceMeta(buffer);
        meta = meta
          ? {
              invoiceNo: meta.invoiceNo || pdfMeta.invoiceNo,
              invoiceDate: meta.invoiceDate || pdfMeta.invoiceDate,
              amount: meta.amount == null ? pdfMeta.amount : meta.amount,
              seller: meta.seller || pdfMeta.seller,
              text: pdfMeta.text,
            }
          : pdfMeta;
      } catch (error) {
        if (!meta) meta = { invoiceNo: '', invoiceDate: '', amount: null, seller: '', text: '' };
        this.log('warn', `PDF 信息解析失败（发票仍会保存）：${error.message}`);
      }
    }
    if (!meta.text) meta.text = '';

    const mailDate = ctx.envelope.date || ctx.parsed.date || new Date();
    const invoiceDate = meta.invoiceDate || formatDate(mailDate);
    const sender = formatSender(ctx.envelope.from) || (ctx.parsed.from && ctx.parsed.from.text) || '';
    const derived = classifyInvoice(meta, {
      fileName: attachment.filename || '',
      subject: ctx.subject || '',
      sender,
    });
    const amountText =
      Number(meta.amount) > 0
        ? `${Number(meta.amount).toFixed(2)}元`
        : meta.invoiceNo
          ? meta.invoiceNo.slice(-6)
          : '金额未知';
    const baseName = `${derived.platform}_${amountText}`;
    const target = uniquePath(ctx.config.saveDir, `${safeFileName(baseName, '发票')}.pdf`);

    try {
      ensureDir(ctx.config.saveDir);
      fs.writeFileSync(target, buffer);
    } catch (error) {
      this.log('error', `保存发票失败：${error.message}`);
      return 'failed';
    }

    const record = {
      id: hash.slice(0, 16),
      hash,
      messageId: ctx.envelope.messageId || '',
      invoiceNo: meta.invoiceNo || '',
      invoiceDate: meta.invoiceDate || '',
      amount: meta.amount || null,
      seller: meta.seller || '',
      platform: derived.platform,
      category: derived.category,
      route: derived.route,
      detail: derived.detail,
      sender,
      subject: ctx.subject || '',
      mailDate: new Date(mailDate).toISOString(),
      fetchedAt: new Date().toISOString(),
      fileName: path.basename(target),
      savedPath: target,
      size: buffer.length,
    };

    if (!this.store.addInvoice(record)) return 'duplicate';
    this.excel.request();
    this.log('success', `已保存发票：${record.fileName}${record.amount ? ` · ¥${record.amount}` : ''}`);
    this.emit('fetch:invoice', record);
    return 'added';
  }
}

async function testConnection(config, password) {
  if (!config.email) throw new Error('请先填写邮箱账号');
  if (!password) throw new Error('请先填写密码或授权码');
  if (!config.host) throw new Error('请填写邮件服务器地址');
  if (config.protocol === 'pop3') {
    const client = new Pop3Client({
      host: config.host,
      port: Number(config.port) || 995,
      secure: config.secure !== false,
      timeout: 25000,
    });
    try {
      await client.connect();
      await client.login(config.email, password);
      const stat = await client.stat();
      return { ok: true, message: `POP3 连接成功，邮箱中共有 ${stat.count} 封邮件。` };
    } finally {
      await client.quit().catch(() => {});
    }
  }
  const client = new ImapFlow({
    host: config.host,
    port: Number(config.port) || 993,
    secure: config.secure !== false,
    auth: { user: config.email, pass: password },
    logger: false,
    clientInfo: { name: '发票捕手', version: '1.0.0', vendor: 'InvoiceCatcher' },
    connectionTimeout: 25000,
    greetingTimeout: 25000,
  });
  try {
    await client.connect();
    let count = null;
    try {
      const status = await client.status(config.mailbox || 'INBOX', { messages: true });
      count = status.messages;
    } catch {
      /* 某些服务器不支持 STATUS，忽略 */
    }
    return {
      ok: true,
      message: `IMAP 连接成功${count != null ? `，「${config.mailbox || 'INBOX'}」中共有 ${count} 封邮件` : ''}。`,
    };
  } finally {
    await client.logout().catch(() => client.close());
  }
}

module.exports = { Fetcher, testConnection, clampRange };
