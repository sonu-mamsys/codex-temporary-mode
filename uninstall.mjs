#!/usr/bin/env node
import { uninstall } from './lib/uninstall.mjs';
uninstall(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
