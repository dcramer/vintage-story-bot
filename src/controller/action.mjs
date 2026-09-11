/**
 * @template {import('zod').ZodType} Schema
 * @typedef {object} ActionDefinition
 * @property {string} name Public RPC/MCP name.
 * @property {Schema} schema Input validation.
 * @property {string} description
 * @property {string} [action] Internal bridge action alias.
 * @property {boolean} [readOnly]
 * @property {boolean} [idempotent]
 * @property {boolean} [destructive]
 */

/**
 * @template {import('zod').ZodType} Schema
 * @param {ActionDefinition<Schema>} definition
 * @returns {ActionDefinition<Schema>}
 */
export function defineAction(definition) {
  return definition;
}
