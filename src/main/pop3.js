'use strict';

const net = require('net');
const tls = require('tls');

/**
 * 一个够用的 POP3 客户端：只依赖 Node 内置 net/tls，
 * 支持 SSL、多行响应、点转义还原，不依赖任何三方库。
 */
class Pop3Client {
  constructor({ host, port, secure = true, timeout = 45000 }) {
    this.host = host;
    this.port = Number(port);
    this.secure = secure !== false;
    this.timeout = timeout;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.waiter = null;
    this.error = null;
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      const options = { host: this.host, port: this.port, servername: this.host };
      const socket = this.secure
        ? tls.connect(options)
        : net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setTimeout(this.timeout);
      socket.on('timeout', () => {
        socket.destroy(new Error('连接超时'));
      });
      socket.on('error', (error) => {
        this.error = error;
        this._rejectWaiter(error);
        fail(error);
      });
      socket.on('close', () => {
        this.closed = true;
        this._rejectWaiter(new Error('连接已断开'));
      });
      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.waiter) {
          const waiter = this.waiter;
          this.waiter = null;
          waiter.resolve();
        }
      });
      const onReady = async () => {
        if (settled) return;
        try {
          const greeting = await this._readLine();
          if (!/^\+OK/.test(greeting)) throw new Error(greeting.replace(/^-ERR\s*/, '') || '服务器拒绝连接');
          settled = true;
          resolve(greeting);
        } catch (error) {
          settled = true;
          reject(error);
        }
      };
      if (this.secure) {
        socket.once('secureConnect', onReady);
      } else {
        socket.once('connect', onReady);
      }
    });
  }

  _waitForData() {
    if (this.error) return Promise.reject(this.error);
    if (this.closed) return Promise.reject(new Error('连接已断开'));
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  _rejectWaiter(error) {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(error);
    }
  }

  async _readLine() {
    for (;;) {
      const index = this.buffer.indexOf('\r\n');
      if (index >= 0) {
        const line = this.buffer.subarray(0, index).toString('utf8');
        this.buffer = this.buffer.subarray(index + 2);
        return line;
      }
      await this._waitForData();
    }
  }

  async _readMultiline() {
    const chunks = [];
    for (;;) {
      const line = await this._readLine();
      if (line === '.') break;
      const stripped = line.startsWith('..') ? line.slice(1) : line;
      chunks.push(Buffer.from(stripped, 'utf8'), Buffer.from('\r\n'));
    }
    return Buffer.concat(chunks);
  }

  async command(command, { multiline = false } = {}) {
    if (this.closed) throw new Error('连接已断开');
    this.socket.write(`${command}\r\n`);
    const line = await this._readLine();
    if (line.startsWith('-ERR')) {
      throw new Error(line.replace(/^-ERR\s*/, ''));
    }
    if (!line.startsWith('+OK')) throw new Error(line);
    return multiline ? this._readMultiline() : line;
  }

  async login(user, password) {
    await this.command(`USER ${user}`);
    await this.command(`PASS ${password}`);
  }

  async stat() {
    const line = await this.command('STAT');
    const parts = line.split(/\s+/);
    return { count: Number(parts[1]) || 0, size: Number(parts[2]) || 0 };
  }

  /** 返回 Map<邮件序号, 唯一 ID> */
  async uidl() {
    const raw = await this.command('UIDL', { multiline: true });
    const map = new Map();
    for (const line of raw.toString('utf8').split('\r\n')) {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (match) map.set(Number(match[1]), match[2].trim());
    }
    return map;
  }

  /** 返回 Map<邮件序号, 字节数> */
  async list() {
    const raw = await this.command('LIST', { multiline: true });
    const map = new Map();
    for (const line of raw.toString('utf8').split('\r\n')) {
      const match = line.match(/^(\d+)\s+(\d+)$/);
      if (match) map.set(Number(match[1]), Number(match[2]));
    }
    return map;
  }

  /** 只取邮件头（TOP index 0），用于在不下载正文的情况下判断日期 */
  async top(index, lines = 0) {
    return this.command(`TOP ${index} ${lines}`, { multiline: true });
  }

  async retr(index) {
    return this.command(`RETR ${index}`, { multiline: true });
  }

  async quit() {
    try {
      if (!this.closed) await this.command('QUIT');
    } catch {
      /* ignore */
    } finally {
      this.close();
    }
  }

  close() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.closed = true;
    this._rejectWaiter(new Error('连接已关闭'));
  }
}

module.exports = Pop3Client;
