import type { z } from 'zod';
import type { Controller } from './controller.ts';
import type { GoalEnvironment, GoalPolicy, GoalRecord, GoalResult, GoalStarted } from './goal.ts';

interface Definition<S extends z.ZodType> {
  name: string;
  schema: S;
  description: string;
  destructive?: boolean;
  readOnly?: boolean;
  idempotent?: boolean;
  concurrent?: boolean;
}

export interface ActionDefinition<S extends z.ZodType = z.ZodType<any>> extends Definition<S> {
  action?: string;
  local?: (runtime: Controller, args: z.output<S>) => Promise<object>;
}

export interface GoalDefinition<S extends z.ZodType = z.ZodType<any>> extends Definition<S> {
  title: (args: z.output<S>) => string;
  announce?: (args: z.output<S>) => string | null;
  run?: GoalPolicy<z.output<S>>;
  compose?: (runtime: Controller, env: GoalEnvironment, args: z.output<S> & { signal: AbortSignal }, record: GoalRecord) => Promise<GoalResult>;
  launch?: (runtime: Controller, args: z.output<S>, record: GoalRecord, started: GoalStarted, signal: AbortSignal) => Promise<unknown>;
}

export const defineAction = <S extends z.ZodType>(definition: ActionDefinition<S>): ActionDefinition<S> => definition;

export const defineGoal = <S extends z.ZodType>(definition: GoalDefinition<S>): GoalDefinition<S> => {
  if (typeof definition.title !== 'function') throw new Error(`Goal ${definition.name} requires a title`);
  return {
    ...definition,
    title: args => definition.title(args).replace(/\s+/g, ' ').trim().slice(0, 240),
  };
};
