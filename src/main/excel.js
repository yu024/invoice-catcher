'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { ensureDir, formatDate, formatDateTime } = require('./util');

const DETAIL_HEADERS = ['序号', '开票日期', '平台', '类别', '金额(元)', '发票号码', '销方名称', '行程', '明细', '文件名'];
const SUMMARY_HEADERS = ['平台', '张数', '金额(元)'];

const HEADER_FILL = 'FF4472C4';
const TOTAL_FILL = 'FFD9E1F2';
const GRID = 'FFD6DCE6';

const thin = { style: 'thin', color: { argb: GRID } };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function amountOf(invoice) {
  const amount = Number(invoice.amount);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function platformOf(invoice) {
  return invoice.platform || '其他';
}

function buildPlatformSummary(invoices) {
  const map = new Map();
  for (const invoice of invoices) {
    const platform = platformOf(invoice);
    const entry = map.get(platform) || { platform, count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += amountOf(invoice) || 0;
    map.set(platform, entry);
  }
  return [...map.values()].sort((a, b) => b.count - a.count || b.amount - a.amount || a.platform.localeCompare(b.platform));
}

function styleHeaderRow(row) {
  row.height = 26;
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { left: thin, right: thin, top: thin, bottom: thin };
  });
}

function styleDataCell(cell, column, options = {}) {
  const centered = options.centered;
  cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF1F2937' } };
  cell.alignment = {
    horizontal: centered ? 'center' : 'left',
    vertical: 'middle',
    wrapText: !centered,
  };
  cell.border = { left: thin, right: thin, top: thin, bottom: thin };
  if (column === 5) cell.numFmt = '0.00';
}

function displayWidth(value) {
  let width = 0;
  for (const char of String(value || '')) {
    width += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(char) ? 2 : 1;
  }
  return width;
}

function estimateLines(value, columnWidth) {
  const width = Math.max(1, columnWidth - 2);
  return Math.max(1, Math.ceil(displayWidth(value) / width));
}

async function writeOverview(file, invoices, options = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '发票捕手';
  workbook.lastModifiedBy = '发票捕手';
  workbook.created = new Date();
  workbook.modified = new Date();

  const sorted = [...invoices].sort((a, b) => {
    const left = a.invoiceDate || formatDate(a.mailDate || a.fetchedAt);
    const right = b.invoiceDate || formatDate(b.mailDate || b.fetchedAt);
    if (left !== right) return String(left).localeCompare(String(right));
    return (a.fetchedAt || 0) - (b.fetchedAt || 0);
  });

  /* ------------------------------ 发票明细 ------------------------------ */

  const detail = workbook.addWorksheet('发票明细', {
    views: [{ state: 'frozen', ySplit: 1 }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    properties: { defaultColWidth: 12 },
  });

  detail.columns = [
    { key: 'index', width: 8 },
    { key: 'invoiceDate', width: 14 },
    { key: 'platform', width: 14 },
    { key: 'category', width: 10 },
    { key: 'amount', width: 12 },
    { key: 'invoiceNo', width: 26 },
    { key: 'seller', width: 36 },
    { key: 'route', width: 46 },
    { key: 'detail', width: 34 },
    { key: 'fileName', width: 34 },
  ];

  styleHeaderRow(detail.addRow(DETAIL_HEADERS));

  let total = 0;
  sorted.forEach((invoice, index) => {
    const amount = amountOf(invoice);
    if (amount) total += amount;
    const row = detail.addRow([
      index + 1,
      invoice.invoiceDate || formatDate(invoice.mailDate || invoice.fetchedAt),
      platformOf(invoice),
      invoice.category || '',
      amount || '',
      invoice.invoiceNo || '',
      invoice.seller || '',
      invoice.route || '未提供',
      invoice.detail || '',
      invoice.fileName || '',
    ]);
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      styleDataCell(cell, col, { centered: col <= 6 });
    });
    const lines = Math.max(
      estimateLines(invoice.seller, 36),
      estimateLines(invoice.route || '未提供', 46),
      estimateLines(invoice.detail, 34),
      estimateLines(invoice.fileName, 34),
    );
    row.height = Math.min(120, Math.max(20, lines * 15 + 6));
  });

  const totalRow = detail.addRow(['合计', '', '', '', total, '', '', '', '', '']);
  totalRow.eachCell({ includeEmpty: true }, (cell, col) => {
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF1F2937' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } };
    cell.alignment = { horizontal: col === 5 ? 'right' : 'center', vertical: 'middle' };
    cell.border = { left: thin, right: thin, top: thin, bottom: thin };
    if (col === 5) cell.numFmt = '0.00';
  });
  detail.lastRow.height = 24;

  const lastRow = Math.max(2, detail.rowCount);
  detail.autoFilter = { from: 'A1', to: `J${lastRow}` };
  detail.pageSetup.printTitlesRow = '1:1';

  /* ------------------------------ 按平台汇总 ------------------------------ */

  const summary = workbook.addWorksheet('按平台汇总', {
    views: [{ state: 'frozen', ySplit: 1 }],
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  summary.columns = [
    { key: 'platform', width: 18 },
    { key: 'count', width: 10 },
    { key: 'amount', width: 14 },
  ];

  styleHeaderRow(summary.addRow(SUMMARY_HEADERS));

  const groups = buildPlatformSummary(sorted);
  let countTotal = 0;
  let amountTotal = 0;
  for (const group of groups) {
    countTotal += group.count;
    amountTotal += group.amount;
    const row = summary.addRow([group.platform, group.count, Number(group.amount.toFixed(2))]);
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.font = { name: 'Calibri', size: 11, color: { argb: 'FF1F2937' } };
      cell.alignment = { horizontal: col === 1 ? 'left' : 'center', vertical: 'middle' };
      cell.border = { left: thin, right: thin, top: thin, bottom: thin };
      if (col === 3) cell.numFmt = '0.00';
      if (col === 2) cell.numFmt = '0';
    });
  }

  const summaryTotal = summary.addRow(['合计', countTotal, Number(amountTotal.toFixed(2))]);
  summaryTotal.eachCell({ includeEmpty: true }, (cell, col) => {
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF1F2937' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } };
    cell.alignment = { horizontal: col === 1 ? 'center' : 'center', vertical: 'middle' };
    cell.border = { left: thin, right: thin, top: thin, bottom: thin };
    if (col === 3) cell.numFmt = '0.00';
  });

  /* ------------------------------ 写盘 ------------------------------ */

  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.tmp`;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
      await workbook.xlsx.writeFile(temp);
      fs.renameSync(temp, file);
      return { file, count: sorted.length, total: Number(total.toFixed(2)) };
    } catch (error) {
      const locked = error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES';
      if (attempt === 3) {
        try {
          if (fs.existsSync(temp)) fs.unlinkSync(temp);
        } catch (ignored) {}
        if (locked) {
          throw new Error('总览表正被占用，请关闭正在打开该文件的 Excel 后重试');
        }
        throw error;
      }
      await sleep(400 * (attempt + 1));
    }
  }
  return { file, count: sorted.length, total: Number(total.toFixed(2)) };
}

class ExcelService {
  constructor(store, logger = () => {}) {
    this.store = store;
    this.log = logger;
    this.filePath = store.getExcelPath();
    this.running = null;
    this.pending = false;
  }

  request() {
    if (this.running) {
      this.pending = true;
      return this.running;
    }
    this.running = this.flush().finally(() => {
      this.running = null;
      if (this.pending) {
        this.pending = false;
        this.request().catch(() => {});
      }
    });
    return this.running;
  }

  async flush() {
    if (this.running) await this.running;
    try {
      await writeOverview(this.filePath, this.store.getInvoices(), {
        cycleNumber: this.store.getCycleSummary().number,
      });
    } catch (error) {
      this.log('warn', error.message || String(error));
    }
    this.running = null;
  }

  async reset() {
    ensureDir(path.dirname(this.filePath));
    await writeOverview(this.filePath, [], { cycleNumber: this.store.getCycleSummary().number });
  }

  get path() {
    return this.filePath;
  }
}

module.exports = { ExcelService, writeOverview, buildPlatformSummary };
