import api from './actions/api.mjs';
import goalStatus from './actions/goal_status.mjs';
import collectStick from './actions/collect_stick.mjs';
import gatherSticks from './actions/gather_sticks.mjs';
import forage from './actions/forage.mjs';
import eat from './actions/eat.mjs';
import equip from './actions/equip.mjs';
import collectItem from './actions/collect_item.mjs';
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
import digBlock from './actions/dig_block.mjs';
import placeBlock from './actions/place_block.mjs';
import stop from './actions/stop.mjs';
import craftItem from './actions/craft_item.mjs';
import harvest from './actions/harvest.mjs';
import fellTree from './actions/fell_tree.mjs';
import useOnBlock from './actions/use_on_block.mjs';
import travel from './actions/travel.mjs';
import explore from './actions/explore.mjs';
import setPoi from './actions/set_poi.mjs';
import pois from './actions/pois.mjs';
import digArea from './actions/dig_area.mjs';
import build from './actions/build.mjs';
import selectRecipe from './actions/select_recipe.mjs';
import knap from './actions/knap.mjs';
import clayform from './actions/clayform.mjs';
import chat from './actions/chat.mjs';
import aimCell from './actions/aim_cell.mjs';

export const actions = [
  api,
  goalStatus,
  collectStick,
  gatherSticks,
  forage,
  eat,
  equip,
  collectItem,
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
  digBlock,
  placeBlock,
  craftItem,
  harvest,
  fellTree,
  useOnBlock,
  travel,
  explore,
  setPoi,
  pois,
  digArea,
  build,
  selectRecipe,
  knap,
  clayform,
  chat,
  aimCell,
  stop,
];
