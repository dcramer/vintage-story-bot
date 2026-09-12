import { randomUUID } from 'node:crypto';

// What happened, as the controller noticed it: a sighting confirmed for the
// first time, a hit, a death, a chat line, a goal ending. A bounded ring with
// the cursor semantics of the mod's life events, plus subscribers (the brain)
// and a bounded wait (an agent's long poll). The bus never decides anything.
export class EventLog {
  session = randomUUID();
  events: any[] = [];
  sequence = 0;
  capacity = 256;
  listeners = new Set<(event: any) => void>();
  emit(type: string, data: Record<string, unknown> = {}) {
    const event = { id: ++this.sequence, at: Date.now(), type, ...data };
    this.events.push(event);
    while (this.events.length > this.capacity) this.events.shift();
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a listener's fault is its own */
      }
    }
    return event;
  }
  // Events after a cursor, oldest first. The cursor returned is the last id
  // examined, so a reader filtering by type never re-reads what it skipped.
  read(after = 0, session?: string | null, { limit = 64, types = null as string[] | null } = {}) {
    const reset = !!session && session !== this.session;
    if (reset) after = 0;
    const missed = reset || after > this.sequence || (this.events.length > 0 && after < this.events[0].id - 1);
    if (after > this.sequence) after = 0;
    const events: any[] = [];
    let cursor = Math.min(after, this.sequence);
    for (const event of this.events) {
      if (event.id <= after) continue;
      if (events.length >= limit) break;
      cursor = event.id;
      if (!types || types.includes(event.type)) events.push(event);
    }
    return { ok: true, session: this.session, cursor, latest: this.sequence, missed, events };
  }
  subscribe(listener: (event: any) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  // Resolves when an event lands after the cursor, or after ms.
  wait(after: number, ms: number, signal?: AbortSignal) {
    if (this.sequence > after) return Promise.resolve();
    return new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      const unsubscribe = this.subscribe(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}
