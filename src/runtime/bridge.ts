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
