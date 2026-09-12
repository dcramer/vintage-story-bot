// Git worktrees that can build, test and drive the bot. A linked worktree shares the main checkout's game
// runtime (.runtime/*) and SDK (.dotnet) through symlinks, gets the gitignored local files named in
// .worktreeinclude, and its own node_modules. Idempotent; stdlib only, so it runs before install.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';

const usage = `Usage: worktree.mjs <command>
  add <name> [--branch NAME] [--from REF]   git worktree add .worktrees/<name> (new or existing branch), then setup
  setup [DIR]                               link .dotnet and .runtime/* to the main checkout, copy .worktreeinclude files, pnpm install
  ensure [DIR]                              setup when DIR (or a hook's stdin cwd) is a linked worktree; silent otherwise
  remove <name|path>                        git worktree remove (refuses unsaved work), then delete its merged branch
  list`;

const [command, ...rest] = process.argv.slice(2);
const flags = {}, positional = [];
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  if (arg.startsWith('--')) flags[arg.slice(2)] = rest[++i];
  else positional.push(arg);
}

function fail(message) { console.error(message); process.exit(1); }
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The main checkout owns .git; a linked worktree's git dir lives under .git/worktrees/<name>.
function repository(cwd) {
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  const own = git(['rev-parse', '--path-format=absolute', '--git-dir'], cwd);
  return { top, main: path.dirname(common), linked: common !== own };
}

const linkedWorktreeOf = (dir) => {
  const repo = repository(dir);
  if (!repo.linked) fail(`${repo.top} is the main checkout; nothing to link. Run from a linked worktree.`);
  return repo;
};

function link(target, at) {
  if (existsSync(at) || isLink(at)) return false;
  mkdirSync(path.dirname(at), { recursive: true });
  symlinkSync(target, at);
  return true;
}
const isLink = (file) => { try { return lstatSync(file).isSymbolicLink(); } catch { return false; } };

// Literal paths only; Claude Code and Codex read the same file with full gitignore syntax.
function includedFiles(main) {
  const file = `${main}/.worktreeinclude`;
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

function setup(dir) {
  const { top, main } = linkedWorktreeOf(dir);
  const linked = [], copied = [];
  if (link(`${main}/.dotnet`, `${top}/.dotnet`)) linked.push('.dotnet');
  if (existsSync(`${main}/.runtime`)) {
    for (const entry of readdirSync(`${main}/.runtime`)) {
      if (link(`${main}/.runtime/${entry}`, `${top}/.runtime/${entry}`)) linked.push(`.runtime/${entry}`);
    }
  }
  for (const relative of includedFiles(main)) {
    const source = `${main}/${relative}`, target = `${top}/${relative}`;
    if (!existsSync(source) || existsSync(target)) continue;
    try { git(['check-ignore', '-q', relative], top); } catch { continue; }
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    copied.push(relative);
  }
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--reporter=silent'], { cwd: top, stdio: ['ignore', 'inherit', 'inherit'] });
  console.log(`worktree ready: ${top} (main ${main}; linked ${linked.length ? linked.join(' ') : 'nothing new'}; copied ${copied.length ? copied.join(' ') : 'nothing new'}; dependencies installed)`);
}

// Claude Code SessionStart hook: the session directory arrives as JSON on stdin ({ cwd }).
async function ensure(dir) {
  if (!dir && !process.stdin.isTTY) {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    try { dir = JSON.parse(input).cwd; } catch { /* no hook payload */ }
  }
  dir = path.resolve(dir ?? process.cwd());
  if (!repository(dir).linked) return;
  setup(dir);
}

function add(name) {
  if (!name) fail(usage);
  const { main } = repository(process.cwd());
  const dir = `${main}/.worktrees/${name}`;
  if (existsSync(dir)) fail(`${dir} already exists; run setup there instead.`);
  const branch = flags.branch ?? name;
  const exists = git(['branch', '--list', branch], main) !== '';
  git(exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, flags.from ?? 'HEAD'], main);
  console.log(`${dir} on ${branch}${exists ? '' : ` from ${flags.from ?? 'HEAD'}`}`);
  setup(dir);
}

function remove(target) {
  if (!target) fail(usage);
  const { main } = repository(process.cwd());
  const dir = path.resolve(existsSync(target) ? target : `${main}/.worktrees/${target}`);
  if (!existsSync(dir)) fail(`${dir} does not exist.`);
  const { top, linked } = repository(dir);
  if (!linked) fail(`${top} is the main checkout.`);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], top);
  git(['worktree', 'remove', top], main);
  let branchState = 'kept';
  try { git(['branch', '-d', branch], main); branchState = 'deleted'; } catch { /* unmerged or detached: keep it */ }
  console.log(`removed ${top}; branch ${branch} ${branchState}`);
}

function list() {
  const lines = git(['worktree', 'list', '--porcelain'], process.cwd()).split('\n\n');
  console.log(JSON.stringify(lines.filter(Boolean).map(block => Object.fromEntries(block.split('\n').map(line => {
    const [key, ...value] = line.split(' ');
    return [key, value.join(' ') || true];
  }))), null, 2));
}

try {
  switch (command) {
    case 'add': add(positional[0]); break;
    case 'setup': setup(path.resolve(positional[0] ?? process.cwd())); break;
    case 'ensure': await ensure(positional[0]); break;
    case 'remove': remove(positional[0]); break;
    case 'list': list(); break;
    default: fail(usage);
  }
} catch (error) { fail(error.stderr?.trim() || error.message); }
