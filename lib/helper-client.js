/**
 * Long-lived JSONL client for the tentacle python helper.
 *
 * The helper speaks one JSON object per line on stdin/stdout (`{"id":…, "op":…}`
 * → `{"id":…, "ok":…}`). Keeping one process alive means an action batch costs
 * one round trip instead of one process spawn per key press — that is what makes
 * a "play the game for me" loop fast enough to be useful.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class HelperClient {
  /**
   * @param {object} options
   * @param {string} options.python  absolute python executable
   * @param {string} options.script  absolute tentacle.py path
   * @param {number} [options.timeoutMs] per-request timeout
   */
  constructor(options) {
    this.python = options.python;
    this.script = options.script;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderrTail = '';
  }

  start() {
    if (this.child) return this;
    this.child = spawn(this.python, [this.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok === false) entry.reject(new Error(String(message.error ?? 'helper error')));
      else entry.resolve(message);
    });
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2_000);
    });
    this.child.on('exit', (code) => {
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`helper exited (${code})`));
        this.pending.delete(id);
      }
      this.child = null;
    });
    return this;
  }

  /** Send one request; resolves with the helper's reply object. */
  request(op, payload = {}) {
    this.start();
    const id = this.nextId++;
    const body = JSON.stringify({ ...payload, op, id }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`helper timeout after ${this.timeoutMs}ms (${op})`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(body);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  stop() {
    if (!this.child) return;
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch {
      /* already gone */
    }
    this.child = null;
  }
}
