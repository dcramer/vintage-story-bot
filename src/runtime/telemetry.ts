import http from 'node:http';
import { bridgePort } from './bridge.ts';

export const dashboardPort = () => bridgePort(process.env.VINTAGE_STORY_DASHBOARD_PORT ?? '42159');

// Fire-and-forget NDJSON stream to the operator dashboard. Never blocks, waits for or retries gameplay;
// drops updates while the dashboard is unreachable. `coalesce` keeps only the latest value per topic between flushes.
export class Telemetry {
  pending = [];
  latest = new Map();
  request = null;
  ready = false;
  timer = null;
  closed = false;
  port: number;
  flushMs: number;
  retryMs: number;
  limit: number;
  constructor({ port = dashboardPort(), flushMs = 200, retryMs = 2000, limit = 256 } = {}) {
    Object.assign(this, { port, flushMs, retryMs, limit });
    this.connect();
  }
  publish(topic, data, { coalesce = false } = {}) {
    if (this.closed) return;
    const line = JSON.stringify({ topic, at: Date.now(), data, log: !coalesce });
    if (coalesce) this.latest.set(topic, line);
    else {
      this.latest.delete(topic);
      this.pending.push(line);
      if (this.pending.length > this.limit) this.pending.shift();
    }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushMs).unref();
  }
  flush() {
    if (!this.ready || !this.request?.writable) return;
    const lines = [...this.pending, ...this.latest.values()];
    this.pending.length = 0;
    this.latest.clear();
    if (lines.length) this.request.write(lines.join('\n') + '\n');
  }
  connect() {
    if (this.closed) return;
    const request = http.request({
      host: '127.0.0.1',
      port: this.port,
      method: 'POST',
      path: '/ingest',
      headers: { 'content-type': 'application/x-ndjson' },
      agent: false,
    });
    const retry = () => {
      if (this.request !== request) return;
      this.request = null;
      this.ready = false;
      request.destroy();
      setTimeout(() => this.connect(), this.retryMs).unref();
    };
    request.on('error', retry);
    request.on('close', retry);
    request.on('response', response => response.resume());
    request.once('socket', socket => {
      socket.unref();
      socket.once('connect', () => {
        if (this.request === request) {
          this.ready = true;
          this.flush();
        }
      });
    });
    request.flushHeaders();
    this.request = request;
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    const request = this.request;
    this.request = null;
    if (this.ready) request?.end();
    else request?.destroy();
  }
}
