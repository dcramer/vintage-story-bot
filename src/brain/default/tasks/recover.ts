// A death marker on the map: the body's things lie there, the last life's tools among
// them, so it is fetched by day before any tool is knapped again.
// A recovery interrupted by danger is left alone for a while wherever the bot is:
// returning to the same grave at once makes the fresh life repeat the death.
import { latestDeathMarker } from '../../../goals/retrieve_body.ts';
import type { Concern, Notes } from '../concern.ts';
import { failedOnItsOwn } from '../concern.ts';

// Ten minutes of recovery effort per latest marker, preserved across restarts.
// A marker is not evidence that dropped belongings still exist there.
export function recoverableBody(markers, notes: Notes, now: number) {
  const marker = latestDeathMarker(markers);
  if (!marker) return false;
  if (notes.recovery?.guid !== marker.guid) notes.recovery = { guid: marker.guid, until: now + 600000 };
  return now < notes.recovery.until;
}

export const recover: Concern = {
  id: 'recover',
  title: 'my things from where I died',
  done: s => !s.body,
  setAside: last => failedOnItsOwn(last) || /^brain: (threat|hurt|relocate)$/.test(last.reason ?? ''),
  setAsideEverywhere: true,
  running: ({ s }) => (s.body ? null : { stop: 'recovery budget exhausted' }),
  run: ({ memory, now }) => ({
    start: 'retrieve_body',
    args: { guid: memory.notes.recovery?.guid, manageFood: false, timeoutMs: Math.max(1000, (memory.notes.recovery?.until ?? now + 600000) - now) },
    why: 'going back for my things',
  }),
};
