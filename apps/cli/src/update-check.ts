import process from 'node:process';
import { refreshUpdateCache } from './updates';

// Bound the complete worker lifetime as well as the HTTP request. This child
// owns no command output and cannot keep the invoking CLI alive.
const deadline = setTimeout(() => process.exit(0), 5000);
const attemptedAt = Number(process.argv[2]);
if (Number.isFinite(attemptedAt) && attemptedAt > 0) await refreshUpdateCache(attemptedAt);
clearTimeout(deadline);
