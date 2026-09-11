import api from './actions/api.mjs';
import goalStatus from './actions/goal_status.mjs';
import collectStick from './actions/collect_stick.mjs';
import gatherSticks from './actions/gather_sticks.mjs';
import observe from './actions/observe.mjs';
import environment from './actions/environment.mjs';
import inspectTarget from './actions/inspect_target.mjs';
import events from './actions/events.mjs';
import respawn from './actions/respawn.mjs';
import inventory from './actions/inventory.mjs';
import inventoryMove from './actions/inventory_move.mjs';
import recipes from './actions/recipes.mjs';
import craft from './actions/craft.mjs';
import scan from './actions/scan.mjs';
import look from './actions/look.mjs';
import moveTo from './actions/move_to.mjs';
import move from './actions/move.mjs';
import selectHotbar from './actions/select_hotbar.mjs';
import interact from './actions/interact.mjs';
import attackBlock from './actions/attack_block.mjs';
import stop from './actions/stop.mjs';

export const actions = [
  api,
  goalStatus,
  collectStick,
  gatherSticks,
  observe,
  environment,
  inspectTarget,
  events,
  respawn,
  inventory,
  inventoryMove,
  recipes,
  craft,
  scan,
  look,
  moveTo,
  move,
  selectHotbar,
  interact,
  attackBlock,
  stop,
];
