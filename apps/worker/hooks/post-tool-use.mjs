#!/usr/bin/env node
import { isFactoryRun, readInput, describeTool, postEvent } from './lib.mjs';

/**
 * PostToolUse — what actually happened. Pairs with tool:pre, never blocks.
 * A hook reports what the runtime did whether the model remembers to or not.
 */
if (!isFactoryRun()) process.exit(0);
const input = await readInput();
const ok = input?.tool_response?.error ? false : true;
await postEvent('tool:post', { tool: input?.tool_name ?? 'unknown', summary: describeTool(input), ok });
process.exit(0);
