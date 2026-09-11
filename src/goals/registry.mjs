import { collectStick } from './collect-stick.mjs';
import { gather } from './gather.mjs';
import { forage, eat } from './forage.mjs';

// Public argument contracts live in controller/actions.mjs; handlers compose runtime skills.
export const goalHandlers = new Map([
  ['move_to', (runtime, args, record, started) => runtime.navigate(args, record, started)],
  ['collect_stick', (runtime, args, record, started) => runtime.runTask(env => collectStick(env.send), args, record, started)],
  ['gather_sticks', (runtime, args, record, started) => runtime.runTask(gather, args, record, started)],
  ['forage', (runtime, args, record, started) => runtime.runTask(forage, args, record, started)],
  ['eat', (runtime, args, record, started) => runtime.runTask(eat, args, record, started)],
]);
