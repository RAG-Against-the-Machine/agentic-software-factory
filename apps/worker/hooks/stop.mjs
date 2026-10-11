#!/usr/bin/env node
import { isFactoryRun, postEvent } from './lib.mjs';

/** Stop — the agent's turn ended. Advisory only. */
if (!isFactoryRun()) process.exit(0);
await postEvent('agent:stopped', {});
process.exit(0);
