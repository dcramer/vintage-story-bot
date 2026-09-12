const maxSteps = 16, maxDepth = 8, maxValues = 256;

class Parser {
  constructor(source) { this.source = source; this.index = 0; this.values = 0; }
  fail(message) { throw new Error(`${message} at offset ${this.index}`); }
  space() {
    while (this.index < this.source.length) {
      if (/\s/.test(this.source[this.index])) { this.index++; continue; }
      if (this.source.startsWith('//', this.index)) {
        const end = this.source.indexOf('\n', this.index + 2); this.index = end < 0 ? this.source.length : end + 1; continue;
      }
      if (this.source.startsWith('/*', this.index)) {
        const end = this.source.indexOf('*/', this.index + 2);
        if (end < 0) this.fail('Unclosed comment');
        this.index = end + 2; continue;
      }
      break;
    }
  }
  eof() { this.space(); return this.index === this.source.length; }
  take(value) {
    this.space();
    if (!this.source.startsWith(value, this.index)) return false;
    this.index += value.length; return true;
  }
  character(value) { if (!this.take(value)) this.fail(`Expected ${value}`); }
  word(value) {
    this.space();
    const end = this.index + value.length;
    if (this.source.slice(this.index, end) !== value || /[A-Za-z0-9_$]/.test(this.source[end] ?? '')) this.fail(`Expected ${value}`);
    this.index = end;
  }
  identifier() {
    this.space();
    const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.source.slice(this.index));
    if (!match) this.fail('Expected identifier');
    this.index += match[0].length; return match[0];
  }
  string() {
    this.space();
    const quote = this.source[this.index];
    if (quote !== '"' && quote !== "'") this.fail('Expected string');
    this.index++; let value = '';
    while (this.index < this.source.length) {
      const character = this.source[this.index++];
      if (character === quote) return value;
      if (character === '\n' || character === '\r' || character.charCodeAt(0) < 0x20) this.fail('Control character in string');
      if (character !== '\\') { value += character; continue; }
      if (this.index >= this.source.length) this.fail('Unclosed string');
      const escape = this.source[this.index++], simple = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', 0: '\0' };
      if (escape in simple) { value += simple[escape]; continue; }
      if (escape === 'u') {
        const hex = this.source.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('Expected four hex digits after \\u');
        value += String.fromCharCode(Number.parseInt(hex, 16)); this.index += 4; continue;
      }
      if (`\\/"'`.includes(escape)) { value += escape; continue; }
      this.fail(`Unsupported escape \\${escape}`);
    }
    this.fail('Unclosed string');
  }
  number() {
    this.space();
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.index));
    if (!match) this.fail('Expected number');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail('Number must be finite');
    return value;
  }
  value(depth = 0) {
    this.space();
    if (depth > maxDepth || ++this.values > maxValues) this.fail('Literal is too complex');
    const character = this.source[this.index];
    if (character === '"' || character === "'") return this.string();
    if (character === '{') return this.object(depth + 1);
    if (character === '[') return this.array(depth + 1);
    if (character === '-' || /\d/.test(character ?? '')) return this.number();
    for (const [word, value] of [['true', true], ['false', false], ['null', null]]) {
      const end = this.index + word.length;
      if (this.source.slice(this.index, end) === word && !/[A-Za-z0-9_$]/.test(this.source[end] ?? '')) { this.index = end; return value; }
    }
    this.fail('Only literal values are allowed');
  }
  array(depth) {
    this.character('['); const value = [];
    this.space(); if (this.take(']')) return value;
    while (true) {
      value.push(this.value(depth));
      this.space();
      if (this.take(']')) return value;
      this.character(','); this.space();
      if (this.take(']')) return value;
    }
  }
  object(depth) {
    this.character('{'); const value = Object.create(null), keys = new Set();
    this.space(); if (this.take('}')) return value;
    while (true) {
      this.space();
      const key = this.source[this.index] === '"' || this.source[this.index] === "'" ? this.string() : this.identifier();
      if (keys.has(key)) this.fail(`Duplicate property ${key}`);
      if (['__proto__', 'prototype', 'constructor'].includes(key)) this.fail(`Property ${key} is not allowed`);
      keys.add(key); this.character(':'); value[key] = this.value(depth);
      this.space();
      if (this.take('}')) return value;
      this.character(','); this.space();
      if (this.take('}')) return value;
    }
  }
}

// This is deliberately a TypeScript-compatible expression subset, not eval:
// `await goals.<existing_goal>({ literalArgs });` repeated in sequence.
export function parseGoalScript(source) {
  const parser = new Parser(source), calls = [];
  parser.space();
  const wrapped = source.slice(parser.index).startsWith('async') && !/[A-Za-z0-9_$]/.test(source[parser.index + 5] ?? '');
  if (wrapped) { parser.word('async'); parser.character('('); parser.character(')'); parser.character('=>'); parser.character('{'); }
  while (true) {
    if (wrapped) { parser.space(); if (parser.take('}')) break; if (parser.eof()) parser.fail('Expected }'); }
    else if (parser.eof()) break;
    parser.word('await'); parser.word('goals'); parser.character('.');
    const name = parser.identifier(); parser.character('(');
    const args = parser.object(1); parser.character(')'); parser.take(';');
    calls.push({ name, args });
    if (calls.length > maxSteps) parser.fail(`At most ${maxSteps} goals are allowed`);
  }
  if (wrapped) { parser.take(';'); if (!parser.eof()) parser.fail('Unexpected code after goal script'); }
  if (!calls.length) parser.fail('At least one goal call is required');
  return calls;
}

export function compileGoalScript(source, definitions) {
  const available = new Map(definitions.filter(goal => goal.name !== 'goal_script' && (goal.run || goal.compose)).map(goal => [goal.name, goal]));
  return parseGoalScript(source).map((call, index) => {
    const goal = available.get(call.name);
    if (!goal) throw new Error(`Goal ${index + 1}: ${call.name} is not an existing composable goal`);
    const parsed = goal.schema.safeParse(call.args);
    if (!parsed.success) throw new Error(`Goal ${index + 1} (${call.name}) invalid arguments: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`);
    return { goal, args: parsed.data };
  });
}

export async function runGoalPlan(plan, invoke, report = () => {}) {
  const results = [];
  for (let index = 0; index < plan.length; index++) {
    const step = plan[index], base = { completed: index, step: index + 1, steps: plan.length, subgoal: { kind: step.goal.name, args: step.args } };
    report({ phase: 'running_goal', ...base });
    try {
      const result = await invoke(step, progress => report({ phase: 'running_goal', ...base,
        subgoal: { ...base.subgoal, progress } }));
      if (result?.ok !== true) throw new Error(result?.error ?? result?.reason ?? 'goal did not report success');
      results.push({ kind: step.goal.name, result });
      report({ phase: 'goal_completed', ...base, completed: index + 1 });
    } catch (error) {
      throw new Error(`Goal ${index + 1}/${plan.length} (${step.goal.name}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return results;
}
