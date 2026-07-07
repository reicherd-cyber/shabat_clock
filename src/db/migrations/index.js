import { migrate1 } from './migrate1.js';

export const migrations = [
  { version: 1, up: migrate1 },
];
