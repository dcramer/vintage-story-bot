import { tools } from '../src/runtime/registry.ts';
import { requestController } from '../src/runtime/rpc.ts';

const [name = 'observe', ...params] = process.argv.slice(2);
const tool = tools.find(tool => tool.name === name || tool.action === name);
let args = {};
let expectedParams = 0;
if (['move', 'interact', 'attack'].includes(name)) args = { durationMs: Number(params[0]) };
if (['select', 'select_hotbar'].includes(name)) args = { slot: Number(params[0]) };
if (name === 'look') args = { yawDegrees: Number(params[0]), pitchDegrees: Number(params[1]) };
expectedParams = Object.keys(args).length;
if (params[0] === '--json' && params.length === 2) {
  try {
    args = JSON.parse(params[1]);
    expectedParams = 2;
  } catch {
    console.error('Invalid JSON arguments.');
    process.exit(1);
  }
}
const parsed = tool?.schema.safeParse(args);
if (!parsed?.success || params.length !== expectedParams) {
  console.error(
    'Usage: control.mjs <action> --json <object>, or observe|scan|stop|move <ms>|look <yaw> <pitch>|select <slot>|interact <ms>|attack <ms>',
  );
  process.exitCode = 1;
} else {
  try {
    const result = await requestController({ action: tool.action ?? tool.name, ...parsed.data });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
