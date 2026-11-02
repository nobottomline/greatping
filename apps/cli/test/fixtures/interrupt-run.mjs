// Exercise the wrapper's signal handler on Windows without sending Ctrl+C to
// the CI runner's shared console. The child tree and taskkill are real.
import { existsSync } from 'node:fs';

const timer = setInterval(() => {
  if (!existsSync(process.env.GREATPING_TEST_INTERRUPT)) return;
  clearInterval(timer);
  process.emit('SIGINT');
}, 20);
timer.unref();
