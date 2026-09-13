import { z } from 'zod';
import { defineAction, defineGoal } from '../src/runtime/define.ts';

// Compile-only checks: these boundaries must not silently widen back to any.
export function checkDefinitions() {
  defineAction({
    name: 'probe',
    schema: z.object({ count: z.number() }),
    description: 'probe',
    local: async (runtime, args) => {
      // @ts-expect-error Arguments come from the schema.
      args.missing;
      // @ts-expect-error The controller is a concrete runtime.
      runtime.missing();
      return {};
    },
  });
  defineGoal({
    name: 'probe',
    schema: z.object({ count: z.number() }),
    description: 'probe',
    // @ts-expect-error Titles receive schema arguments too.
    title: args => args.missing,
    // @ts-expect-error Every goal must return ok.
    run: async env => {
      // @ts-expect-error Goal composition has a defined environment.
      env.missing();
      return { reason: 'missing ok' };
    },
  });
}
