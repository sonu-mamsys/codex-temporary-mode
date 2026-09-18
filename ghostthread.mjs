#!/usr/bin/env node
import { main } from './lib/terminal.mjs';
main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
