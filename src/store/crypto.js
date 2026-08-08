/**
 * crypto.js — AES 加密存储支持（Web Crypto API）
 * ----------------------------------------------------------------
 * 使用 AES-GCM 256 位。密钥由用户口令派生（PBKDF2）。
 * 渲染进程内即可运行，无需 Node。
 *
 * 设计要点：
 *  - 每条密文带随机 12 字节 IV，防止相同明文产生相同密文。
 *  - 导出格式：base64( iv || ciphertext )，便于落盘/存 IndexedDB。
 *  - 锁定后内存中不保留密钥明文（仅保留派生出的 CryptoKey，且可被丢弃）。
 */
(function (global) {
  'use strict';

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function toB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function fromB64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function deriveKey(password, salt) {
    const baseKey = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  class CryptoBox {
    constructor() {
      /** @type {CryptoKey|null} */
      this._key = null;
      this._salt = null; // Uint8Array 16
      this.locked = true;
    }

    get isUnlocked() {
      return !this.locked && !!this._key;
    }

    /** 用口令解锁（首次会生成 salt 并持久） */
    async unlock(password, existingSaltB64) {
      this._salt = existingSaltB64 ? fromB64(existingSaltB64) : crypto.getRandomValues(new Uint8Array(16));
      this._key = await deriveKey(password, this._salt);
      this.locked = false;
      return toB64(this._salt);
    }

    /** 锁定：丢弃密钥 */
    lock() {
      this._key = null;
      this.locked = true;
    }

    get saltB64() {
      return this._salt ? toB64(this._salt) : null;
    }

    async encryptString(plain) {
      if (!this.isUnlocked) throw new Error('CryptoBox 未解锁');
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this._key, enc.encode(plain));
      return toB64(iv.buffer) + '.' + toB64(ct);
    }

    async decryptString(payload) {
      if (!this.isUnlocked) throw new Error('CryptoBox 未解锁');
      const [ivB64, ctB64] = payload.split('.');
      const iv = fromB64(ivB64);
      const ct = fromB64(ctB64);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, this._key, ct);
      return dec.decode(pt);
    }
  }

  global.CryptoBox = CryptoBox;
  global.cryptoUtil = { toB64, fromB64 };
})(window);
