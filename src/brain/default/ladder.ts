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
// On a world that has returned a full carried inventory after death, darkness
// alone should not abandon durable work when no food can be eaten. This is
// learned from play, never assumed. Once the home, storage, farm, and stockpile
// are established, the ordinary night routine takes over again.
export const progressThroughRespawn = (s: Situation) =>
  s.keepInventory === true &&
  s.reserve === 0 &&
  (starving(s) || !s.house || !s.storage || s.moreStorage === true || s.farmTended === false || s.stocked === false);
// The starter shelter is enough to recover from a failed night. Once it
// exists, darkness alone should not consume half the run that could establish
// the permanent house; threats and storms still keep their higher priority.
const establishingHouse = (s: Situation) => !!s.rammedShelter && !s.house;

type Tried = Set<Job>;
const sealedInTheDark = (s: Situation, tried: Tried) =>
  !progressThroughRespawn(s) && !establishingHouse(s) && !!s.sheltered && s.lit === false && !s.hurt && !hungry(s) && !tried.has('lighting');
const threatWhileSealed = (s: Situation) => !!s.sheltered && s.threat && !s.hurt && !hungry(s);
// Hurt and dug in: keep pressure on the only exit. An opening failure is
// transient (a hostile at the mouth moves on), so this rung deliberately does
// not wait out the tried window the way the other escape rungs do.
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
const unlitAtHome = (s: Situation, tried: Tried) =>
  !progressThroughRespawn(s) && !establishingHouse(s) && s.atHome && s.lit === false && s.torches > 0 && !tried.has('lighting');
const stormAwayFromHome = (s: Situation, tried: Tried) => s.storm && s.home && !s.atHome && !tried.has('go_home');
const stormWithCover = (s: Situation) => s.storm && ((s.home && s.atHome) || s.burrowed);
// A dig-in that failed here is not tried again at once either: once burrow
// and shift have both been tried, the storm rungs below stop matching until
// the tried window expires, so the ladder does something else instead of
// re-issuing the same failed dig-in every evaluation.
const stormNowhereToDig = (s: Situation, tried: Tried) =>
  s.storm && !(s.home && s.atHome) && !s.burrowed && tried.has('burrow') && !tried.has('shift');
const stormNoCover = (s: Situation, tried: Tried) => s.storm && !tried.has('burrow');
// Starving with an empty pack and no cover to keep: the burrow rule (opened
// whatever stands outside) extended to the open. Storms and active threats
// still win, short and lethal beats slow starvation; night does not, a night
// of hunger kills surer than what hunts in it. A dug-in bot opens the burrow
// first through the rung below. Failed searches cool down through the tried
// window like every other rung.
export const snackSearch = (s: Situation) =>
  !progressThroughRespawn(s) && starving(s) && !(s.reserve > 0) && !s.storm && !s.threat && !s.burrowed;
// An active threat still wins above and triggers a flight. Once it is gone,
// historical scares must not replace unfinished durable work with a long
// relocation on a proven keep-inventory world where death already preserves
// that progress. Farm construction has its own guarded-site rejection.
const badGround = (s: Situation, tried: Tried) =>
  s.dangerHere && !progressThroughRespawn(s) && !establishingHouse(s) && !s.burrowed && !tried.has('relocate');
const nightAwayFromHome = (s: Situation, tried: Tried) =>
  s.night && !progressThroughRespawn(s) && !establishingHouse(s) && s.home && !s.atHome && !tried.has('go_home');
const nightWithCover = (s: Situation) => s.night && !progressThroughRespawn(s) && !establishingHouse(s) && ((s.home && s.atHome) || s.burrowed);
// A burrow that failed here (rock, nothing to seal it): walk on and dig in elsewhere, never stand in the dark.
const nightNowhereToDig = (s: Situation, tried: Tried) =>
  s.night &&
  !progressThroughRespawn(s) &&
  !establishingHouse(s) &&
  !(s.home && s.atHome) &&
  !s.burrowed &&
  tried.has('burrow') &&
  !tried.has('shift');
const nightNoCover = (s: Situation, tried: Tried) => s.night && !progressThroughRespawn(s) && !establishingHouse(s) && !tried.has('burrow');
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
  { job: 'eat', when: (s, tried) => snackSearch(s) && !tried.has('eat') },
  { job: 'relocate', when: badGround },
  { job: 'go_home', when: nightAwayFromHome },
  { job: 'wait', when: nightWithCover },
  { job: 'shift', when: nightNowhereToDig },
  { job: 'burrow', when: nightNoCover },
  { job: 'unburrow', when: burrowedAndCalm },
  { job: 'shelter', when: readyToBuildShelter },
];
