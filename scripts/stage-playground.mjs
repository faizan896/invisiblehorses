import { cpSync, mkdirSync, rmSync } from 'node:fs';
const destination = new URL('../public/playground/', import.meta.url);
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
cpSync(new URL('../packages/payroute/playground/dist/', import.meta.url), destination, { recursive: true });
console.log('Static playground staged at public/playground/');
