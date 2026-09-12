import net from 'node:net';
import { once } from 'node:events';
import { Effect } from 'effect';
import { Controller } from './runtime/controller.mjs';
import { controllerPort } from './runtime/rpc.mjs';
import { Telemetry } from './runtime/telemetry.mjs';
import { Reporter } from './runtime/reporter.mjs';

const sinks = [new Telemetry(), Reporter.fromEnv()].filter(Boolean);
const telemetry = { publish: (...args) => sinks.forEach(sink => sink.publish(...args)), close: () => sinks.forEach(sink => sink.close()) };
const controller = new Controller(undefined, telemetry), sockets = new Set();
const maxRequestBytes = 16384;
controller.eye();
const server = net.createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
  socket.setTimeout(15000, () => socket.destroy());
  let line = '', handled = false;
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    if (handled) return;
    line += chunk;
    if (Buffer.byteLength(line) > maxRequestBytes) {
      handled = true; socket.end(JSON.stringify({ ok: false, error: `Controller request exceeds ${maxRequestBytes - 1} bytes.` }) + '\n'); return;
    }
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
      telemetry.close();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }),
  );
  console.error(`Vintage Story controller 0.1.0 on 127.0.0.1:${controllerPort()} (structured data only)`);
  telemetry.publish('controller', controller.info());
  yield* Effect.never;
}));
try { await Effect.runPromise(program, { signal: shutdown.signal }); }
catch (error) { if (!shutdown.signal.aborted) { console.error(error.message); process.exitCode = 1; } }
