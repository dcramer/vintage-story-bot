import { runGoal } from '../src/runtime/rpc.ts';

const cancellation = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => cancellation.abort());
try {
  const result = await runGoal({ action: 'collect_stick' }, { signal: cancellation.signal });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
