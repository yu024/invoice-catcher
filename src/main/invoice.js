'use strict';

const pdfParse = require('pdf-parse');

function pad(value) {
  return String(value).padStart(2, '0');
}

function toNumber(raw) {
  if (!raw) return null;
  const value = Number(String(raw).replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function cleanSeller(value) {
  if (!value) return '';
  return String(value)
    .replace(/(纳税人识别号|统一社会信用代码|地址|电话|开户行|银行账号|账号).*$/s, '')
    .replace(/[\s\u00a0]{2,}/g, ' ')
    .trim()
    .slice(0, 40);
}

function cleanLine(value) {
  if (!value) return '';
  return String(value)
    .replace(/[\s\u00a0]{2,}/g, ' ')
    .replace(/^[：:·\-\s]+|[：:·\-\s]+$/g, '')
    .trim()
    .slice(0, 80);
}

const PLATFORM_RULES = [
  { name: '滴滴出行', test: /滴滴/ },
  { name: '享道出行', test: /享道/ },
  { name: '地铁', test: /地铁|轨道交通|申通地铁/ },
  { name: '铁路', test: /铁路|12306|火车票/ },
  { name: '京东', test: /京东|圆迈贸易/ },
  { name: '美团', test: /美团|三快/ },
  { name: '饿了么', test: /饿了么|拉扎斯/ },
  { name: '高德', test: /高德/ },
  { name: '曹操出行', test: /曹操/ },
  { name: 'T3 出行', test: /T3出行|T3 出行/ },
  { name: '哈啰', test: /哈啰|哈罗/ },
  { name: '顺丰', test: /顺丰/ },
  { name: '携程', test: /携程/ },
  { name: '飞猪', test: /飞猪/ },
  { name: '航空', test: /航空|机票/ },
  { name: '麦当劳', test: /麦当劳|金拱门|mcdonald/i },
  { name: '肯德基', test: /肯德基|kfc/i },
  { name: '星巴克', test: /星巴克|starbucks/i },
];

function pickPlatform(meta, hints = {}) {
  const haystack = [meta.text, meta.seller, hints.fileName, hints.subject, hints.sender]
    .filter(Boolean)
    .join('\n');
  for (const rule of PLATFORM_RULES) {
    if (rule.test.test(haystack)) return rule.name;
  }
  return '其他';
}

function pickCategory(meta, platform) {
  const haystack = [platform, meta.detail, meta.seller].filter(Boolean).join('\n');
  if (/客运|运输|交通|打车|出行|地铁|铁路|航空|行程/.test(haystack)) return '交通';
  if (/餐饮|餐费|食品|外卖/.test(haystack)) return '餐饮';
  if (/住宿|酒店|住宿服务/.test(haystack)) return '住宿';
  if (/商品|销售|商贸|贸易|京东|商城|电器|设备/.test(haystack)) return '商品';
  if (/服务费|技术服务|咨询服务|信息服务/.test(haystack)) return '服务';
  return '其他';
}

function pickRoute(text) {
  if (!text) return '';
  const normalized = text.replace(/\r/g, '');
  const pair = normalized.match(/(?:起点|出发地|上车地点)[:：]?\s*([^\n]{2,60})[\s\S]{0,80}?(?:终点|目的地|下车地点)[:：]?\s*([^\n]{2,60})/);
  if (pair) {
    const route = `${cleanLine(pair[1])} → ${cleanLine(pair[2])}`;
    if (route.replace(/[→\s]/g, '').length > 4) return route.slice(0, 120);
  }
  const trip = normalized.match(/(?:行程|路线)[:：]\s*([^\n]{4,120})/);
  if (trip) {
    const route = cleanLine(trip[1]);
    if (route.length > 4) return route.slice(0, 120);
  }
  const arrow = normalized.match(/([^\n，。；]{2,40})\s*(?:→|—>|->)\s*([^\n，。；]{2,40})/);
  if (arrow) return `${cleanLine(arrow[1])} → ${cleanLine(arrow[2])}`.slice(0, 120);
  return '';
}

function pickDetail(text) {
  if (!text) return '';
  const star = text.match(/\*([^*\n]{2,24})\*([^*\n]{1,40})/);
  if (star) {
    let tail = star[2].replace(/\s+\d[\s\S]*$/, '');
    if (/\d+\.\d+/.test(tail)) tail = tail.replace(/\d+(?:\.\d+)+[\s\S]*$/, '');
    tail = tail.replace(/\s{2,}.*$/, '');
    return cleanLine(`${star[1]}-${tail}`).slice(0, 60);
  }
  const item = text.match(/(?:项目名称|货物或应税劳务、服务名称|货物或应税劳务名称|服务名称)[:：]?\s*([^\n]{2,60})/);
  if (item) return cleanLine(item[1]).slice(0, 60);
  return '';
}

/**
 * 从 PDF 文本中尽量提取发票关键信息。
 * 解析失败不影响文件保存，只是总览表里对应字段留空。
 */
async function extractInvoiceMeta(buffer) {
  const meta = { invoiceNo: '', invoiceDate: '', amount: null, seller: '', text: '' };
  let text = '';
  try {
    const parsed = await pdfParse(buffer, { max: 0 });
    text = parsed.text || '';
  } catch (error) {
    meta.error = error.message;
    return meta;
  }
  meta.text = text;
  const compact = text.replace(/[\s\u00a0]+/g, '');

  const invoiceNoMatch =
    compact.match(/(?:发票号码|发票号)[:：]?([0-9]{8,20})/) ||
    compact.match(/数电票号码[:：]?([0-9]{20})/) ||
    compact.match(/票据号码[:：]?([0-9]{8,32})/);
  if (invoiceNoMatch) meta.invoiceNo = invoiceNoMatch[1];
  if (!meta.invoiceNo) {
    // 部分版式把「发票号码：」和号码拆成单独一行
    const line = text.split(/\r?\n/).map((item) => item.trim()).find((item) => /^\d{20}$/.test(item));
    if (line) meta.invoiceNo = line;
  }

  const dateMatch =
    compact.match(/(?:开票日期|开具日期|开票时间)[:：]?(\d{4})年(\d{1,2})月(\d{1,2})日/) ||
    compact.match(/(?:开票日期|开具日期)[:：]?(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (dateMatch) {
    meta.invoiceDate = `${dateMatch[1]}-${pad(dateMatch[2])}-${pad(dateMatch[3])}`;
  }
  if (!meta.invoiceDate) {
    const looseDate = text.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
    if (looseDate) meta.invoiceDate = `${looseDate[1]}-${pad(looseDate[2])}-${pad(looseDate[3])}`;
  }

  const amountMatch =
    text
      .replace(/\s+/g, '')
      .match(/价税合计[（(]?大写[）)]?[^（(]{0,40}?[（(]小写[）)][:：]?[¥￥]?([0-9,]+\.\d{2})/) ||
    text.replace(/\s+/g, '').match(/价税合计[^0-9]{0,40}?([0-9,]+\.\d{2})/) ||
    compact.match(/[（(]小写[）)][:：]?[¥￥]([0-9,]+\.\d{2})/) ||
    compact.match(/(?:合计金额|金额合计)[:：]?[¥￥]?([0-9,]+\.\d{2})/);
  if (amountMatch) meta.amount = toNumber(amountMatch[1]);

  if (meta.amount == null) {
    // 价税合计区域被拆散时：用「金额 + 税额 = 合计」的关系找出总金额
    const compactNoSpace = text.replace(/\s+/g, '');
    const values = [...compactNoSpace.matchAll(/([0-9,]+\.[0-9]{2})[¥￥]/g)]
      .map((match) => toNumber(match[1]))
      .filter((value) => value != null);
    for (let i = 0; i < values.length - 2; i += 1) {
      if (Math.abs(values[i] + values[i + 1] - values[i + 2]) < 0.005) {
        meta.amount = values[i + 2];
        break;
      }
    }
    if (meta.amount == null && values.length > 0) meta.amount = Math.max(...values);
  }

  const sellerIndex = text.search(/销售方/);
  if (sellerIndex >= 0) {
    const segment = text.slice(sellerIndex, sellerIndex + 500);
    const nameMatch = segment.match(/名称[:：]\s*([^\n\r]{2,60})/);
    if (nameMatch && !/^(名称|统一社会信用代码|纳税人识别号)/.test(nameMatch[1])) {
      meta.seller = cleanSeller(nameMatch[1]);
    }
  }
  if (!meta.seller) {
    const fallback = text.match(/销售方(?:名称)?[:：]\s*([^\n\r]{2,60})/);
    if (fallback && !/^(名称|统一社会信用代码|纳税人识别号)/.test(fallback[1])) meta.seller = cleanSeller(fallback[1]);
  }
  if (!meta.seller) {
    // 竖排版式里「销 售 方」被换行拆开，用去掉空白后的文本定位；两栏拼接时销售方在后
    const flatIndex = compact.search(/销售方/);
    if (flatIndex >= 0) {
      const segment = compact.slice(flatIndex, flatIndex + 600);
      const names = [...segment.matchAll(/([\u4e00-\u9fa5（）()A-Za-z0-9·]{2,40}?(?:有限责任公司|股份有限公司|有限公司|公司))/g)]
        .map((match) => match[1])
        .filter((name) => !/^(购买方|销售方)/.test(name));
      if (names.length > 0) meta.seller = cleanSeller(names[names.length - 1]);
    }
  }

  return meta;
}

function xmlTag(xml, names) {
  for (const name of names) {
    const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
    if (match && match[1].trim()) return match[1].trim();
  }
  return '';
}

/** 用开票平台提供的 XML 精确解析字段，作为 PDF 文本解析的补充。 */
function parseInvoiceXml(xmlSource) {
  const xml = Buffer.isBuffer(xmlSource) ? xmlSource.toString('utf8') : String(xmlSource || '');
  if (!xml) return null;

  const invoiceNo = xmlTag(xml, ['EIid', 'InvoiceNumber', 'EInvoiceNumber', 'InvoiceNo']);
  const rawDate = xmlTag(xml, ['IssueTime', 'IssueDate', 'InvoiceDate']);
  const dateMatch = /(20\d{2})[-/年]?(\d{1,2})[-/月]?(\d{1,2})/.exec(rawDate);
  const invoiceDate = dateMatch
    ? `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`
    : '';
  const rawAmount = xmlTag(xml, [
    'TotalTax-includedAmount',
    'TotaltaxIncludedAmount',
    'TotalAmWithTax',
    'TotalAmount',
    'AmountWithTax',
  ]);
  const amount = /\d+(?:\.\d+)?/.test(rawAmount) ? Number(/(\d+(?:\.\d+)?)/.exec(rawAmount)[1]) : null;
  const seller = xmlTag(xml, ['SellerName', 'SellerNameCN', 'SalerName']);

  if (!invoiceNo && !invoiceDate && !seller && amount == null) return null;
  return { invoiceNo, invoiceDate, amount, seller, text: '' };
}

/**
 * 根据 PDF 文本和邮件信息，推断「平台 / 类别 / 行程 / 明细」等汇总表字段。
 */
// 用户规则：行程单/行程报销单不算发票，滴滴等平台的行程单不允许入库。
const ITINERARY_PATTERN = /行程单|行程报销单|行程明细|itinerary/i;

function isItineraryAttachment(name) {
  return ITINERARY_PATTERN.test(String(name || ''));
}

function classifyInvoice(meta, hints = {}) {
  const platform = pickPlatform(meta, hints);
  const route = pickRoute(meta.text) || '未提供';
  const detail = pickDetail(meta.text);
  const category = pickCategory({ ...meta, detail }, platform);
  return { platform, category, route, detail };
}

module.exports = { extractInvoiceMeta, parseInvoiceXml, classifyInvoice, isItineraryAttachment };
