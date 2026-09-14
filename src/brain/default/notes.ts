// Saved camp notes: what the brain decided about this world, kept between runs.
// Parsed field by field so one corrupt entry cannot wipe the rest; unknown
// entries are dropped, never misread. Version 1 is the shape always written;
// a newer version reads as empty rather than wrong.
import { z } from 'zod';
import type { Cell, Notes, Stash } from './concern.ts';

export const NOTES_VERSION = 1;

const cell = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });
const optCell = (value: unknown): Cell | undefined => {
  const parsed = cell.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const stash = z.object({
  key: z.string(),
  code: z.string(),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  full: z.boolean().optional(),
  seen: z.object({ at: z.number().finite(), items: z.record(z.string(), z.number()) }).nullish(),
});
const parseStash = (value: unknown): Stash | null => {
  const parsed = stash.safeParse(value);
  if (!parsed.success) return null;
  const { key, code, x, y, z, full, seen } = parsed.data;
  return { key, ...(full === undefined ? {} : { full }), x, y, z, code, seen: seen ?? null };
};
const recovery = z.object({ guid: z.string(), until: z.number().finite() });
const farm = z.object({
  origin: cell,
  turn: z.number().int().min(0).max(3),
  soil: z.string().regex(/^game:soil-(medium|high|compost)-none$/),
  wood: z.string().regex(/^[a-z]+$/),
});
const construction = z.object({
  origin: cell,
  phase: z.enum(['survey', 'site', 'walls', 'floor', 'enter']),
});
const firepit = cell.extend({ until: z.number().finite() });

export function parseNotes(kept: unknown): Notes {
  const from = (kept && typeof kept === 'object' ? kept : {}) as Record<string, unknown>;
  if (from.version !== undefined && from.version !== NOTES_VERSION) return { home: null, stash: null, dwelling: null };
  const shelter = optCell(from.shelter);
  const starter = optCell(from.starter);
  const firepitCell = optCell(from.firepit);
  const house = optCell(from.house);
  const lightingDay = finite(from.lightingDay);
  const keptRecovery = recovery.safeParse(from.recovery);
  const keptFarm = farm.safeParse(from.farm);
  const keptBuilding = construction.safeParse(from.construction);
  const dwelling = from.dwelling as Record<string, unknown> | undefined;
  const door = optCell(dwelling?.door);
  return {
    ...(keptRecovery.success ? { recovery: keptRecovery.data } : {}),
    ...(from.keepInventory === true ? { keepInventory: true as const } : {}),
    home: optCell(from.home) ?? null,
    ...(shelter ? { shelter } : {}),
    ...(starter ? { starter } : {}),
    ...(lightingDay !== undefined ? { lightingDay } : {}),
    ...(firepitCell ? { firepit: firepitCell } : {}),
    ...(Array.isArray(from.failedFirepits) && from.failedFirepits.length > 0
      ? {
          failedFirepits: from.failedFirepits
            .map(pit => {
              const parsed = firepit.safeParse(pit);
              return parsed.success ? parsed.data : null;
            })
            .filter((pit): pit is Cell & { until: number } => !!pit)
            .slice(-16),
        }
      : {}),
    ...(from.foodRecovery === true ? { foodRecovery: true as const } : {}),
    ...(house ? { house } : {}),
    ...(keptFarm.success
      ? {
          farm: {
            ...keptFarm.data,
            rotation: Number.isInteger((from.farm as Record<string, unknown>)?.rotation)
              ? ((((from.farm as Record<string, unknown>).rotation as number) % 4) + 4) % 4
              : 0,
            prepared: (from.farm as Record<string, unknown>)?.prepared === true,
            checkedAt: finite((from.farm as Record<string, unknown>)?.checkedAt) ?? 0,
            ...(Number.isInteger((from.farm as Record<string, unknown>)?.siteFailures) &&
            ((from.farm as Record<string, unknown>).siteFailures as number) > 0
              ? { siteFailures: (from.farm as Record<string, unknown>).siteFailures as number }
              : {}),
          },
        }
      : {}),
    ...(keptBuilding.success
      ? {
          // The survey flag is not restored: the footprint is re-surveyed live.
          construction: {
            ...keptBuilding.data,
            ...((from.construction as Record<string, unknown>)?.foundationVerified === true ? { foundationVerified: true as const } : {}),
          },
        }
      : {}),
    stash: parseStash(from.stash),
    ...(Array.isArray(from.stores)
      ? {
          stores: from.stores
            .map(parseStash)
            .filter((s): s is Stash => !!s)
            .slice(0, 2),
        }
      : {}),
    dwelling: door && typeof dwelling?.item === 'string' ? { door, item: dwelling.item } : null,
  };
}
