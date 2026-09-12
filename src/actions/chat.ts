import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';

export default defineAction({
  name: 'chat',
  schema: z.object({
    message: z.string().min(1).max(256).describe('Plain status text sent to the server general chat. Leading / or . is stripped so it never runs a command.'),
  }).strict(),
  description:
    'Send one plain chat line to the server general chat as the bot. Fire-and-forget; not gameplay control. ' +
    'Leading command characters are stripped. Goals announce themselves automatically on start.',
});
