#!/usr/bin/env node
// Extract every crafting recipe from the installed game assets into docs/recipes.json and a
// stone-age index in docs/recipes.md. Facts only: outputs, ingredients, patterns, tool needs.
//   node scripts/recipes.ts [--assets <dir>]   (default .runtime/linux-client/assets/survival)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const root =
  args[args.indexOf('--assets') + 1] && args.includes('--assets')
    ? args[args.indexOf('--assets') + 1]
    : join(process.cwd(), '.runtime/linux-client/assets/survival');
const recipesDir = join(root, 'recipes');

// The game reads its JSON with Newtonsoft's lenient parser: unquoted keys, comments, trailing commas, tabs.
export function parseLenient(text) {
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith('//', i)) {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (text.startsWith('/*', i)) {
        i = text.indexOf('*/', i + 2) + 2;
        continue;
      }
      return;
    }
  };
  const string = quote => {
    let out = '';
    i++;
    while (text[i] !== quote) {
      if (text[i] === '\\') {
        const c = text[++i];
        out += { n: '\n', t: '\t', r: '\r' }[c] ?? c;
      } else out += text[i];
      i++;
    }
    i++;
    return out;
  };
  const value = () => {
    skip();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj = {};
      for (;;) {
        skip();
        if (text[i] === '}') {
          i++;
          return obj;
        }
        const key =
          text[i] === '"' || text[i] === "'"
            ? string(text[i])
            : (() => {
                let k = '';
                while (/[\w$.\-*]/.test(text[i])) k += text[i++];
                return k;
              })();
        skip();
        i++; // colon
        obj[key] = value();
        skip();
        if (text[i] === ',') i++;
      }
    }
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        skip();
        if (text[i] === ']') {
          i++;
          return arr;
        }
        arr.push(value());
        skip();
        if (text[i] === ',') i++;
      }
    }
    if (c === '"' || c === "'") return string(c);
    let token = '';
    while (i < text.length && /[\w.+-]/.test(text[i])) token += text[i++];
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (token !== '' && !Number.isNaN(Number(token))) return Number(token);
    throw Error(`Unexpected token ${JSON.stringify(token || c)} at ${i}`);
  };
  return value();
}

const files = dir =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.json') ? [join(dir, entry.name)] : [],
  );
const list = value => (Array.isArray(value) ? value : [value]);
const code = ref => (ref?.code == null ? null : String(ref.code).includes(':') ? String(ref.code) : `game:${ref.code}`);
const ingredient = (ref, key?) =>
  ref && {
    ...(key !== undefined ? { key } : {}),
    type: ref.type ?? 'item',
    code: code(ref),
    ...(ref.tags ? { tags: ref.tags } : {}),
    quantity: ref.quantity ?? 1,
    ...(ref.name ? { variable: ref.name } : {}),
    ...(ref.allowedVariants ? { allowedVariants: ref.allowedVariants } : {}),
    ...(ref.skipVariants ? { skipVariants: ref.skipVariants } : {}),
    ...(ref.isTool ? { tool: true, durabilityCost: ref.toolDurabilityCost ?? 1 } : {}),
    ...(ref.consumeQuantity != null ? { consumeQuantity: ref.consumeQuantity } : {}),
    ...(ref.attributes ? { attributes: ref.attributes } : {}),
    ...(ref.isWildCard ? { wildcard: true } : {}),
    ...(ref.litres != null ? { litres: ref.litres } : {}),
  };
const output = ref =>
  ref && {
    type: ref.type ?? 'item',
    code: code(ref),
    quantity: ref.quantity ?? 1,
    ...(ref.attributes ? { attributes: ref.attributes } : {}),
    ...(ref.litres != null ? { litres: ref.litres } : {}),
  };
const voxels = pattern =>
  list(pattern)
    .flat()
    .join('')
    .split('')
    .filter(c => c === '#').length;

function grid(recipe) {
  const pattern = String(recipe.ingredientPattern ?? '')
    .split(/[,\t]/)
    .map(row => row.trim())
    .filter(Boolean);
  const used = new Set(pattern.join('').replace(/_/g, ''));
  return {
    kind: 'grid',
    name: recipe.name ?? null,
    output: output(recipe.output),
    width: recipe.width ?? pattern[0]?.length ?? 1,
    height: recipe.height ?? pattern.length,
    shapeless: recipe.shapeless ?? false,
    pattern,
    ingredients: Object.entries(recipe.ingredients ?? {})
      .filter(([key]) => used.has(key))
      .map(([key, ref]) => ingredient(ref, key)),
    ...(recipe.allowedVariants ? { allowedVariants: recipe.allowedVariants } : {}),
    ...(recipe.requiresTrait ? { requiresTrait: recipe.requiresTrait } : {}),
    ...(recipe.copyAttributesFrom ? { copyAttributesFrom: recipe.copyAttributesFrom } : {}),
  };
}
const forming = kind => recipe => ({
  kind,
  name: recipe.name ?? null,
  output: output(recipe.output),
  ingredient: ingredient(recipe.ingredient),
  layers: list(recipe.pattern).length,
  voxels: voxels(recipe.pattern),
  pattern: recipe.pattern,
});
const cooking = recipe => ({
  kind: 'cooking',
  name: recipe.code ?? null,
  output: output(recipe.output),
  perishable: recipe.perishableHours ?? null,
  ingredients: (recipe.ingredients ?? []).map(slot => ({
    code: slot.code,
    minQuantity: slot.minQuantity ?? 0,
    maxQuantity: slot.maxQuantity ?? 1,
    validStacks: (slot.validStacks ?? []).map(stack => ({
      type: stack.type ?? 'item',
      code: code(stack),
      ...(stack.shapeless != null ? {} : {}),
      ...(stack.cookedStack ? { cooked: output(stack.cookedStack) } : {}),
    })),
  })),
});
const barrel = recipe => ({
  kind: 'barrel',
  name: recipe.code ?? null,
  output: output(recipe.output),
  sealHours: recipe.sealHours ?? 0,
  ingredients: (recipe.ingredients ?? []).map(ref => ingredient(ref)),
});
const smithing = recipe => ({
  kind: 'smithing',
  name: recipe.name ?? null,
  output: output(recipe.output),
  ingredient: ingredient(recipe.ingredient),
  layers: list(recipe.pattern).length,
  voxels: voxels(recipe.pattern),
});
const alloy = recipe => ({
  kind: 'alloy',
  output: output(recipe.output),
  ingredients: (recipe.ingredients ?? []).map(ref => ({ code: code(ref), minRatio: ref.minRatio, maxRatio: ref.maxRatio })),
});
const parsers = { grid, knapping: forming('knapping'), clayforming: forming('clayforming'), cooking, barrel, smithing, alloy };

const recipes = [];
for (const [kind, parse] of Object.entries(parsers)) {
  for (const file of files(join(recipesDir, kind))) {
    let parsed;
    try {
      parsed = parseLenient(readFileSync(file, 'utf8'));
    } catch (error) {
      console.error(`skip ${file}: ${error.message}`);
      continue;
    }
    for (const recipe of list(parsed)) {
      if (recipe?.enabled === false) continue;
      recipes.push({ ...parse(recipe), source: file.slice(recipesDir.length + 1) });
    }
  }
}
recipes.sort((a, b) => a.kind.localeCompare(b.kind) || String(a.output?.code).localeCompare(String(b.output?.code)));

// Stone-age closure: start from what a player picks up or breaks by hand, then add every grid, knapping
// or clay-forming output whose inputs are already reachable, until nothing new appears. Smelting, casting
// and firing are not recipes: raw pottery counts as fired; metal never enters because ingots never do.
const wild = [
  'stick',
  'stone-*',
  'flint',
  'obsidian',
  'clay-*',
  'cattailtops',
  'cattailroot',
  'papyrustops',
  'papyrusroot',
  'drygrass',
  'log-*',
  'bone',
  'hide-*',
  'fat',
  'resin',
  'sand-*',
  'gravel-*',
  'soil-*',
  'rock-*',
  'treeseed-*',
  'seeds-*',
  'fruit-*',
  'vegetable-*',
  'mushroom-*',
  'grain-*',
  'flaxfibers',
  'feather',
  'egg-*',
  'honeycomb',
  'peat',
  'waterportion',
  'saltwaterportion',
  'bamboo-*',
  'seashell-*',
  'leaves-*',
  'sapling-*',
  'fern',
  'tallgrass-*',
  'nugget-*',
  'charcoal',
  'reeds-*',
  'cactus-*',
  'poultry-*',
  'redmeat-*',
  'bushmeat-*',
  'fish-*',
  'insect-*',
  'snowlayer',
  'ice',
  'looseboulders-*',
  'looseflints-*',
  'loosestones-*',
  'flower-*',
  'thatch',
  'hay-*',
];
const prefix = pattern =>
  String(pattern ?? '')
    .replace(/^game:/, '')
    .replace(/[*{].*$/, '');
const isWild = pattern => /[*{]/.test(String(pattern ?? ''));
const satisfied = (input, known) => {
  if (input.tags)
    return list(input.tags)
      .flat(Infinity)
      .map(String)
      .some(tag => tag.startsWith('tool-') && [...known].some(k => k.startsWith(`${tag.slice(5)}-`)));
  if (!input.code) return false;
  const want = prefix(input.code);
  if (want === '') return true;
  return [...known].some(k =>
    isWild(input.code) ? k.startsWith(want) || (isWild(k) && want.startsWith(prefix(k))) : k === want || (isWild(k) && want.startsWith(prefix(k))),
  );
};
const known = new Set(wild.map(prefix).map(w => wild.find(x => prefix(x) === w)));
const craftable = ['grid', 'knapping', 'clayforming'];
const stoneAge = [];
for (let added = true; added; ) {
  added = false;
  for (const r of recipes) {
    if (!craftable.includes(r.kind) || stoneAge.includes(r) || r.requiresTrait) continue;
    const inputs = r.kind === 'grid' ? r.ingredients : [r.ingredient];
    if (!inputs.every(i => satisfied(i, known))) continue;
    stoneAge.push(r);
    added = true;
    // An output whose code starts with a variable would match everything; keep it out of the known set.
    if (prefix(r.output.code) === '') continue;
    known.add(prefix(r.output.code) + (isWild(r.output.code) ? '*' : ''));
    if (/-raw$/.test(r.output.code)) known.add(prefix(r.output.code.replace(/-raw$/, '-fired')) + (isWild(r.output.code) ? '*' : ''));
  }
}

const generatedFrom = `game 1.22.7 assets (${recipes.length} recipes)`;
writeFileSync(join(process.cwd(), 'docs/recipes.json'), JSON.stringify({ generatedFrom, recipes }, null, 1) + '\n');

const short = c => String(c ?? '').replace(/^game:/, '');
const ingredientsText = r =>
  r.kind === 'grid'
    ? r.ingredients
        .map(i => `${i.quantity > 1 ? `${i.quantity}×` : ''}${i.code ? short(i.code) : (i.tags ?? []).join('|')}${i.tool ? ' (tool)' : ''}`)
        .join(', ')
    : `${short(r.ingredient?.code)} (${r.voxels} voxels${r.layers > 1 ? `, ${r.layers} layers` : ''})`;
const rows = [
  ...new Set(
    stoneAge.map(
      r =>
        `| ${r.kind} | ${short(r.output.code)}${r.output.quantity > 1 ? ` ×${r.output.quantity}` : ''} | ${ingredientsText(r)} | ${r.kind === 'grid' ? r.pattern.join(' / ') : '-'} |`,
    ),
  ),
];
const md = `# Recipes

Generated by \`node scripts/recipes.ts\` from the installed game assets; regenerate after a game update, never edit by hand. Full data: [recipes.json](recipes.json) — every grid, knapping, clay-forming, cooking, barrel, smithing and alloy recipe with output, ingredients (\`*\` wildcards, \`{variable}\` substitutions, tool flags) and patterns. Codes are block/item codes as \`recipes\`, \`craft_item\`, \`knap\` and \`clayform\` take them; \`_\` in a grid pattern is an empty cell, rows are separated by \` / \`. Ingredient quantities are per pattern cell.

## Stone age (reachable from hand-gathered materials, no smelting)

| Kind | Output | Ingredients | Grid pattern |
| --- | --- | --- | --- |
${rows.join('\n')}
`;
writeFileSync(join(process.cwd(), 'docs/recipes.md'), md);
console.log(`${recipes.length} recipes → docs/recipes.json; ${stoneAge.length} stone-age rows → docs/recipes.md`);
