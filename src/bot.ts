// One Seraph: the shared controller on a loopback port, the eye reading what
// the player sees, and an installed brain that plays on its own. With no
// brain the bot does nothing until an adapter (CLI, script, agent) tells it to.
//   pnpm bot [--brain default]      VINTAGE_STORY_BRAIN=default

import { once } from 'node:events';
import net from 'node:net';
import { installBrain } from './runtime/brain.ts';
import { Controller } from './runtime/controller.ts';
import { Reporter } from './runtime/reporter.ts';
import { controllerPort } from './runtime/rpc.ts';
import { Telemetry } from './runtime/telemetry.ts';

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const brainName = argument('--brain') ?? process.env.VINTAGE_STORY_BRAIN ?? null;

const sinks: any[] = [new Telemetry(), Reporter.fromEnv()].filter(Boolean);
const telemetry = {
  publish: (...args: unknown[]) => {
    for (const sink of sinks) sink.publish(...args);
  },
  close: () => {
    for (const sink of sinks) sink.close();
  },
};
const controller = new Controller(undefined, telemetry as any);
const sockets = new Set<net.Socket>();
const maxRequestBytes = 16384;

const server = net.createServer(socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  socket.setTimeout(15000, () => socket.destroy());
  let line = '',
    handled = false;
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    if (handled) return;
    line += chunk;
    if (Buffer.byteLength(line) > maxRequestBytes) {
      handled = true;
      socket.end(JSON.stringify({ ok: false, error: `Controller request exceeds ${maxRequestBytes - 1} bytes.` }) + '\n');
      return;
    }
    if (!line.includes('\n')) return;
    handled = true;
    Promise.resolve()
      .then(() => controller.request(JSON.parse(line.trim())))
      .catch(error => ({ ok: false, error: error.message }))
      .then(result => {
        if (!socket.destroyed) socket.end(JSON.stringify(result) + '\n');
      });
  });
});

const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown.abort());

try {
  server.listen(controllerPort(), '127.0.0.1');
  await once(server, 'listening');
  console.error(`Vintage Story controller 0.1.0 on 127.0.0.1:${controllerPort()} (structured data only)`);
  controller.eye();
  telemetry.publish('controller', controller.info());
  if (brainName) {
    await installBrain(controller, brainName);
    console.error(`brain ${brainName} installed`);
  }
  await new Promise<void>(resolve => shutdown.signal.addEventListener('abort', () => resolve(), { once: true }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await controller.close();
  telemetry.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
