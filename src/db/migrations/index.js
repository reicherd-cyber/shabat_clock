import { migrate1 } from './migrate1.js';
import { migrate2 } from './migrate2.js';
import { migrate3 } from './migrate3.js';
import { migrate4 } from './migrate4.js';
import { migrate5 } from './migrate5.js';
import { migrate6 } from './migrate6.js';
import { migrate7 } from './migrate7.js';

export const migrations = [
  { version: 1, up: migrate1 },
  { version: 2, up: migrate2 },
  { version: 3, up: migrate3 },
  { version: 4, up: migrate4 },
  { version: 5, up: migrate5 },
  { version: 6, up: migrate6 },
  { version: 7, up: migrate7 },
];
