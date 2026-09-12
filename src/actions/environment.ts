import { defineAction } from '../runtime/define.ts';
import { empty as schema } from '../runtime/schemas.ts';

export default defineAction({
  name: 'environment',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Read local calendar/season/daylight, climate, wind (native vector), light levels and temporal-storm phase. ' +
    'Climate: temperature C, precipitation/rainfall, fertility, forest/shrub density, geology, ' +
    'biomeId (-1 absent). Generation densities are search priors, not current plants or resource ' +
    'guarantees. Null/unavailable is unknown. No remote climate/hidden-region queries.',
});
