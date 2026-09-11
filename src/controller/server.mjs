import net from 'node:net';
import { once } from 'node:events';
import { Effect } from 'effect';
import { Controller } from './runtime.mjs';
import { controllerPort } from './client.mjs';

const controller = new Controller(), sockets = new Set();
const server = net.createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
  socket.setTimeout(15000, () => socket.destroy());
  let line = '', handled = false;
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    if (handled) return;
    line += chunk;
    if (Buffer.byteLength(line) > 1024) { socket.destroy(); return; }
    if (!line.includes('\n')) return;
    handled = true;
    Promise.resolve().then(() => controller.request(JSON.parse(line.trim())))
      .catch(error => ({ ok: false, error: error.message }))
      .then(result => { if (!socket.destroyed) socket.end(JSON.stringify(result) + '\n'); });
  });
});
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown.abort());
const program = Effect.scoped(Effect.gen(function* () {
  yield* Effect.acquireRelease(
    Effect.tryPromise(async () => { server.listen(controllerPort(), '127.0.0.1'); await once(server, 'listening'); return server; }),
    () => Effect.promise(async () => {
      await controller.close();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }),
  );
  console.error(`Vintage Story controller 0.1.0 on 127.0.0.1:${controllerPort()} (structured data only)`);
  yield* Effect.never;
}));
try { await Effect.runPromise(program, { signal: shutdown.signal }); }
catch (error) { if (!shutdown.signal.aborted) { console.error(error.message); process.exitCode = 1; } }
