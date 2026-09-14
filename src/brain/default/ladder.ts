// The ladder: danger, then hunger, then a storm, a bad place, night, then the
// list. A sealed burrow is already the safest response to something prowling
// outside: opening it to flee turns cover into a trap, and only actual damage
// proves the shelter unsafe. Hungry and dug in with nothing carried, it must
// dig out to look. A hostile that cannot be run from (across water, on a
// ledge) is not run from again at once; a dig-in that failed here is not
// tried again at once either. A completed burrow exit is always retried: it
// was sealed with a block the bot itself carried, so an opening failure is transient.
import type { Job, Rung } from './concern.ts';
import { hungry } from './reflexes/eat.ts';
import type { Situation } from './situation.ts';

// Below this satiety a burrow is opened whatever stands outside.
export const STARVING = 0.1;
const starving = (s: Situation) => s.hunger !== null && s.hunger < STARVING;
// The starter shelter is enough to recover from a failed night. Once it
// exists, darkness alone should not consume half the run that could establish
// the permanent house; threats and storms still keep their higher priority.
const establishingHouse = (s: Situation) => !!s.rammedShelter && !s.house;

type Tried = Set<Job>;
const sealedInTheDark = (s: Situation, tried: Tried) =>
  !establishingHouse(s) && !!s.sheltered && s.lit === false && !s.hurt && !hungry(s) && !tried.has('lighting');
const threatWhileSealed = (s: Situation) => !!s.sheltered && s.threat && !s.hurt && !hungry(s);
const hurtInBurrow = (s: Situation) => s.burrowed && s.hurt;
const besiegedInBurrow = (s: Situation, tried: Tried) => s.burrowed && s.threat && !s.hurt && s.besieged && !tried.has('tunnel');
// Rock stopped every tunnel: open the mouth and run (the hide rung takes over once outside), but not
// onto a hostile at the mouth unless starvation leaves no choice.
const tunnelsFailed = (s: Situation, tried: Tried) =>
  s.burrowed && s.threat && !s.hurt && s.besieged && tried.has('tunnel') && (!s.threatNear || starving(s));
const threatWhileBurrowed = (s: Situation) => s.burrowed && s.threat && !s.hurt;
const hurtOrThreat = (s: Situation, tried: Tried) => s.hurt || (s.threat && !tried.has('hide'));
const hungryWithFood = (s: Situation, tried: Tried) => (hungry(s) || !!s.foodRecovery) && s.reserve > 0 && !tried.has('eat');
// Open the house and repair it from outside in daylight. At night the intact
// seal is more valuable than immediately reaching an exterior wall or roof gap.
const damageAtHome = (s: Situation, tried: Tried) => s.home && !!s.homeDamaged && !s.night && !s.storm && !tried.has('repair_home');
const unlitAtHome = (s: Situation, tried: Tried) => !establishingHouse(s) && s.atHome && s.lit === false && s.torches > 0 && !tried.has('lighting');
const stormAwayFromHome = (s: Situation, tried: Tried) => s.storm && s.home && !s.atHome && !tried.has('go_home');
const stormWithCover = (s: Situation) => s.storm && ((s.home && s.atHome) || s.burrowed);
const stormNowhereToDig = (s: Situation, tried: Tried) => s.storm && !(s.home && s.atHome) && !s.burrowed && tried.has('burrow');
const stormNoCover = (s: Situation) => s.storm;
const badGround = (s: Situation) => s.dangerHere && !establishingHouse(s) && !s.burrowed;
const nightAwayFromHome = (s: Situation, tried: Tried) => s.night && !establishingHouse(s) && s.home && !s.atHome && !tried.has('go_home');
const nightWithCover = (s: Situation) => s.night && !establishingHouse(s) && ((s.home && s.atHome) || s.burrowed);
// A burrow that failed here (rock, nothing to seal it): walk on and dig in elsewhere, never stand in the dark.
const nightNowhereToDig = (s: Situation, tried: Tried) =>
  s.night && !establishingHouse(s) && !(s.home && s.atHome) && !s.burrowed && tried.has('burrow');
const nightNoCover = (s: Situation) => s.night && !establishingHouse(s);
const burrowedAndCalm = (s: Situation, tried: Tried) => s.burrowed && !tried.has('unburrow');
const readyToBuildShelter = (s: Situation, tried: Tried) => !!s.shelterReady && !tried.has('shelter');

export const LADDER: Rung[] = [
  { job: 'lighting', when: sealedInTheDark },
  { job: 'wait', when: threatWhileSealed },
  { job: 'unburrow', when: hurtInBurrow },
  { job: 'tunnel', when: besiegedInBurrow },
  { job: 'unburrow', when: tunnelsFailed },
  { job: 'wait', when: threatWhileBurrowed },
  { job: 'hide', when: hurtOrThreat },
  { job: 'eat', when: hungryWithFood },
  { job: 'repair_home', when: damageAtHome },
  { job: 'lighting', when: unlitAtHome },
  { job: 'go_home', when: stormAwayFromHome },
  { job: 'wait', when: stormWithCover },
  { job: 'shift', when: stormNowhereToDig },
  { job: 'burrow', when: stormNoCover },
  { job: 'relocate', when: badGround },
  { job: 'go_home', when: nightAwayFromHome },
  { job: 'wait', when: nightWithCover },
  { job: 'shift', when: nightNowhereToDig },
  { job: 'burrow', when: nightNoCover },
  { job: 'unburrow', when: burrowedAndCalm },
  { job: 'shelter', when: readyToBuildShelter },
];
