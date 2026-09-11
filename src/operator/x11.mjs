// Minimal X11 wire client: ask a window to close (WM_PROTOCOLS / WM_DELETE_WINDOW). GLFW handles the request on the
// game's main thread, which is the only exit path that saves cleanly; SIGTERM tears the session down off-thread.
// Talks to the abstract socket without authentication, which the managed Xvfb accepts.
import net from 'node:net';

export function socketPath(display) {
  const number = display?.match(/^:(\d+)(?:\.\d+)?$/)?.[1];
  if (number === undefined) throw new Error('DISPLAY must look like :7.');
  return `\0/tmp/.X11-unix/X${number}`;
}

function connect(display) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath(display) });
    let buffer = Buffer.alloc(0);
    const waiters = [];
    let failure = null;
    const drain = () => {
      while (waiters.length && buffer.length >= waiters[0].length) {
        const { length, resolve } = waiters.shift();
        resolve(buffer.subarray(0, length));
        buffer = buffer.subarray(length);
      }
    };
    const fail = error => {
      failure ??= error;
      while (waiters.length) waiters.shift().reject(failure);
      socket.destroy();
      reject(failure);
    };
    socket.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); drain(); });
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('X server closed the connection.')));
    socket.setTimeout(5000, () => fail(new Error('X server timed out.')));
    const read = length => new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      waiters.push({ length, resolve, reject });
      drain();
    });
    socket.once('connect', () => resolve({ socket, read }));
  });
}

async function handshake({ socket, read }) {
  socket.write(Buffer.from([0x6c, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const head = await read(8);
  if (head[0] !== 1) throw new Error('X server refused the connection (authentication required?).');
  await read(head.readUInt16LE(6) * 4);
}

async function internAtom({ socket, read }, name) {
  const pad = (4 - (name.length % 4)) % 4;
  const request = Buffer.alloc(8 + name.length + pad);
  request[0] = 16;
  request.writeUInt16LE(request.length / 4, 2);
  request.writeUInt16LE(name.length, 4);
  request.write(name, 8, 'latin1');
  socket.write(request);
  const reply = await read(32);
  if (reply[0] !== 1) throw new Error(`InternAtom ${name} failed.`);
  return reply.readUInt32LE(8);
}

export async function requestWindowClose(display, windowId) {
  const window = Number(windowId);
  if (!Number.isInteger(window) || window <= 0) throw new Error('Invalid window id.');
  const connection = await connect(display);
  try {
    await handshake(connection);
    const protocols = await internAtom(connection, 'WM_PROTOCOLS');
    const remove = await internAtom(connection, 'WM_DELETE_WINDOW');
    const request = Buffer.alloc(44);
    request[0] = 25;
    request.writeUInt16LE(11, 2);
    request.writeUInt32LE(window, 4);
    const event = request.subarray(12);
    event[0] = 33;
    event[1] = 32;
    event.writeUInt32LE(window, 4);
    event.writeUInt32LE(protocols, 8);
    event.writeUInt32LE(remove, 12);
    await new Promise((resolve, reject) => connection.socket.write(request, error => (error ? reject(error) : resolve())));
  } finally {
    connection.socket.destroy();
  }
}
