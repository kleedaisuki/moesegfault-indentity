#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { main } from '../skills/moesegfault-identity/scripts/device-login.mjs';
export * from '../skills/moesegfault-identity/scripts/device-login.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}${error.correlationId ? ` (correlation ${error.correlationId})` : ''}\n`);
    process.exitCode = 1;
  });
}
