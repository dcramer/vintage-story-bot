/**
 * @typedef {object} ActionDefinition One public query/command; file `src/actions/<name>.mjs`, default export.
 * @property {string} name Public RPC/MCP name; must equal the file basename.
 * @property {import('zod').ZodType} schema Input validation.
 * @property {string} description
 * @property {string} [action] Mod wire action when it differs from name.
 * @property {boolean} [readOnly]
 * @property {boolean} [idempotent]
 * @property {boolean} [destructive]
 * @property {(runtime: object, args: object) => Promise<object>} [local] Controller-local handler; otherwise forwarded to the mod.
 */
export const defineAction = definition => definition;

/**
 * @typedef {object} GoalDefinition One long-running goal; file `src/goals/<name>.mjs`, default export.
 * @property {string} name Public RPC/MCP name; must equal the file basename.
 * @property {import('zod').ZodType} schema Input validation.
 * @property {string} description
 * @property {boolean} [destructive]
 * @property {(args: object) => string} [announce] Server-chat line posted when the goal starts.
 * @property {(env: object, args: object) => Promise<object>} [run] Task policy run under runtime.runTask.
 * @property {(runtime: object, args: object, record: object, started: object) => import('effect').Effect.Effect<any>} [launch]
 *   Custom Effect launcher for goals that bypass runTask (move_to).
 */
export const defineGoal = definition => definition;
