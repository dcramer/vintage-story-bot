import net from 'node:net';

export function bridgePort(value = process.env.VINTAGE_STORY_BRIDGE_PORT ?? '42157') {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('VINTAGE_STORY_BRIDGE_PORT must be an integer from 1 to 65535.');
  }
  return Number(value);
}

// A lost acknowledgement can still mean the game acted. Never auto-retry.
export type BridgeOptions = { port?: number; timeoutMs?: number; requestMaxBytes?: number; maxBytes?: number; signal?: AbortSignal };
export function requestBridge(
  request: object,
  { port = bridgePort(), timeoutMs = 4000, requestMaxBytes = 1024, maxBytes = 262144, signal }: BridgeOptions = {},
): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Bridge request cancelled; inspect before retrying.'));
    const line = JSON.stringify(request) + '\n';
    if (Buffer.byteLength(line) > requestMaxBytes) return reject(new Error(`Request exceeds ${requestMaxBytes - 1} bytes.`));
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Bridge timed out. Unpause the world; do not blindly retry a game action.')), timeoutMs);
    function finish(error: Error | null, result?: any) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }
    const abort = () => finish(new Error('Bridge request cancelled; inspect before retrying.'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(line));
    socket.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) return finish(new Error('Bridge response exceeds size limit.'));
      response += chunk;
      const end = response.indexOf('\n');
      if (end < 0) return;
      try {
        const result = JSON.parse(response.slice(0, end));
        if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
          throw new Error('Expected an object with boolean ok.');
        }
        finish(null, result);
      } catch (error) {
        finish(new Error(`Invalid bridge response: ${error.message}`));
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) =>
      finish(
        new Error(
          `Cannot reach Vintage Story bridge (${error.code ?? error.message}). Launch the bot and load a world (pnpm game start); the mod listens once the world is ready. Run MCP on the same OS as the bot.`,
        ),
      ),
    );
    socket.on('close', () => finish(new Error('Bridge closed without a complete response. The world may be paused or unloaded.')));
  });
}

// One connection the controller keeps open to the mod: requests carry a requestId,
// many are in flight at once, and replies are paired by requestId as they come back
// in any order. Each request keeps its own deadline; a reply after it is
// ignored. A lost connection rejects everything in flight and the next request
// reconnects. A lost acknowledgement can still mean the game acted: no retries.
export class BridgeClient {
  port: number;
  timeoutMs: number;
  requestMaxBytes: number;
  maxBytes: number;
  socket: net.Socket | null = null;
  ready: Promise<void> | null = null;
  pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: any; abort?: () => void; signal?: AbortSignal }
  >();
  next = 0;
  buffer = '';
  constructor({ port = bridgePort(), timeoutMs = 4000, requestMaxBytes = 1024, maxBytes = 262144 }: BridgeOptions = {}) {
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.requestMaxBytes = requestMaxBytes;
    this.maxBytes = maxBytes;
  }
  request = (request: object, { timeoutMs = this.timeoutMs, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<any> => {
    return new Promise<any>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Bridge request cancelled; inspect before retrying.'));
      const id = ++this.next;
      const line = JSON.stringify({ ...request, requestId: id }) + '\n';
      if (Buffer.byteLength(line) > this.requestMaxBytes) return reject(new Error(`Request exceeds ${this.requestMaxBytes - 1} bytes.`));
      const entry = {
        resolve,
        reject,
        signal,
        timer: setTimeout(() => this.settle(id, new Error('Bridge timed out. Unpause the world; do not blindly retry a game action.')), timeoutMs),
        abort: () => this.settle(id, new Error('Bridge request cancelled; inspect before retrying.')),
      };
      this.pending.set(id, entry);
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.connect().then(
        socket => {
          if (this.pending.has(id) && !socket.destroyed) socket.write(line);
        },
        error => this.settle(id, error),
      );
    });
  };
  // The open socket, or a fresh one; connection errors reject every waiting request together.
  connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed && this.ready) return this.ready.then(() => this.socket as net.Socket);
    const socket = net.createConnection({ host: '127.0.0.1', port: this.port });
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    this.socket = socket;
    this.buffer = '';
    let connected = false;
    this.ready = new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        connected = true;
        resolve();
      });
      socket.on('error', (error: NodeJS.ErrnoException) => {
        const failure = new Error(
          connected
            ? 'Bridge closed without a complete response. The world may be paused or unloaded.'
            : `Cannot reach Vintage Story bridge (${error.code ?? error.message}). Launch the bot and load a world (pnpm game start); the mod listens once the world is ready. Run MCP on the same OS as the bot.`,
        );
        reject(failure);
        this.drop(socket, failure);
      });
      socket.on('close', () => {
        const failure = new Error('Bridge closed without a complete response. The world may be paused or unloaded.');
        reject(failure);
        this.drop(socket, failure);
      });
      socket.on('data', (chunk: string) => this.receive(socket, chunk));
    });
    this.ready.catch(() => {});
    return this.ready.then(() => socket);
  }
  receive(socket: net.Socket, chunk: string) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > this.maxBytes) return this.drop(socket, new Error('Bridge response exceeds size limit.'));
    let end = this.buffer.indexOf('\n');
    while (end >= 0) {
      const text = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let result: any;
      try {
        result = JSON.parse(text);
        if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') throw new Error('Expected an object with boolean ok.');
      } catch (error) {
        return this.drop(socket, new Error(`Invalid bridge response: ${error.message}`));
      }
      // A reply without a requestId answers the oldest request still waiting.
      const id = typeof result.requestId === 'number' ? result.requestId : this.pending.keys().next().value;
      if (id !== undefined && this.pending.has(id)) {
        delete result.requestId;
        this.settle(id, null, result);
      }
      end = this.buffer.indexOf('\n');
    }
  }
  settle(id: number, error: Error | null, result?: any) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.abort) entry.signal?.removeEventListener('abort', entry.abort);
    if (error) entry.reject(error);
    else entry.resolve(result);
  }
  drop(socket: net.Socket, error: Error) {
    if (this.socket === socket) {
      this.socket = null;
      this.ready = null;
    }
    socket.destroy();
    for (const id of [...this.pending.keys()]) this.settle(id, error);
  }
  close() {
    const socket = this.socket;
    if (socket) this.drop(socket, new Error('Bridge client closed.'));
  }
}
