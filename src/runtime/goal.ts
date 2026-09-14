import type { Places } from '../support/places.ts';
import type { Controller } from './controller.ts';
import type { GameClient } from './game.ts';
import type { Log } from './log.ts';
import type { Navigation } from './navigation/navigator.ts';

export type Outcome = 'done' | 'interrupted' | 'refused' | 'no_progress' | 'failed';
export type GoalResult = { ok: boolean; reason?: string; code?: string; outcome?: Outcome; [key: string]: unknown };
export type GoalProgress = Record<string, unknown>;

export interface GoalEnvironment {
  send: GameClient['send'];
  map: GameClient['map'];
  surface: GameClient['surface'];
  sightings: GameClient['sightings'];
  wants: string[];
  places: Places;
  looks: { last: unknown };
  sync: GameClient['snapshot'];
  aim(angles: { yawDegrees: number; pitchDegrees?: number }, safety?: { allowStarvingRecovery?: boolean }): Promise<void>;
  navigate: (
    goal: Record<string, unknown>,
    pauseWhen?: (state: any) => string | null,
    safety?: { allowStarvingRecovery?: boolean; avoidThreats?: boolean },
  ) => ReturnType<Controller['navigate']>;
  log: Log;
  report(progress: GoalProgress): void;
}

export type GoalPolicy<Args = Record<string, unknown>> = (env: GoalEnvironment, args: Args & { signal: AbortSignal }) => Promise<GoalResult>;

export interface GoalRecord {
  id: string;
  kind: string;
  title: string;
  args: Record<string, any>;
  by: string;
  state: string;
  startedAt: number;
  finishedAt?: number;
  abort: AbortController;
  done?: Promise<void>;
  nav?: Navigation;
  intent?: string;
  reason?: string;
  code?: string;
  outcome?: Outcome;
  result?: GoalResult;
  progress?: GoalProgress;
  cleanupError?: string;
  logged?: string;
  log?: Log;
}

export type GoalStarted = { resolve(result: { ok: boolean; [key: string]: unknown }): void };
