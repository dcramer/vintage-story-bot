// A death marker on the map: the body's things lie there, the last life's tools among
// them, so it is fetched by day before any tool is knapped again.
// A recovery interrupted by danger is left alone for a while wherever the bot is:
// returning to the same grave at once makes the fresh life repeat the death.
import type { Concern } from '../concern.ts';
import { failedOnItsOwn } from '../concern.ts';

export const recover: Concern = {
  id: 'recover',
  title: 'my things from where I died',
  done: s => !s.body,
  setAside: last => failedOnItsOwn(last) || /^brain: (threat|hurt|relocate)$/.test(last.reason ?? ''),
  setAsideEverywhere: true,
  run: () => ({ start: 'retrieve_body', args: { manageFood: true, timeoutMs: 900000 }, why: 'going back for my things' }),
};
