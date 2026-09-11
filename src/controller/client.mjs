import { bridgePort, requestBridge } from '../bridge/client.mjs';

export const controllerPort = () => bridgePort(process.env.VINTAGE_STORY_CONTROLLER_PORT ?? '42158');
export async function requestController(request) {
  try { return await requestBridge(request, { port: controllerPort(), timeoutMs: 10000 }); }
  catch (error) { throw new Error(`Controller: ${error.message} Start pnpm controller; never retry a mutation blindly.`); }
}

export async function runGoal(request, { signal } = {}) {
  if (signal?.aborted) return { ok: false, error: 'Cancelled before start' };
  const started = await requestController(request);
  if (!started.ok) return started;
  const id = started.goal?.id ?? started.navigation?.id;
  if (!id) throw new Error('Expected a goal id; inspect state before retrying.');
  while (true) {
    if (signal?.aborted) { await requestController({ action: 'stop', expectedGoal: id }); return { ok: false, error: 'Cancelled' }; }
    const state = await requestController({ action: 'goal_status', id });
    if (!state.ok) return state;
    if (!state.goal?.active) return state.goal.result ?? { ok: state.goal.state === 'arrived', ...state.goal };
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
