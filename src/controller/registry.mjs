import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Every `src/actions/*.mjs` and `src/goals/*.mjs` file is one public tool named after its basename.
// No registry edits: add a file, restart the controller.
async function load(dir) {
  const base = new URL(`../${dir}/`, import.meta.url);
  const files = readdirSync(fileURLToPath(base)).filter(file => file.endsWith('.mjs')).sort();
  return Promise.all(files.map(async file => {
    const tool = (await import(new URL(file, base))).default;
    const expected = file.slice(0, -4);
    if (tool?.name !== expected || !tool.schema || !tool.description)
      throw new Error(`${dir}/${file} must default-export a tool named ${expected} with schema and description`);
    return tool;
  }));
}

export const actions = await load('actions');
export const goals = await load('goals');
export const tools = [...actions, ...goals];
export const findTool = name => tools.find(tool => tool.name === name || tool.action === name);
