import { migrate1 } from './migrate1.js';
import { migrate2 } from './migrate2.js';
import { migrate3 } from './migrate3.js';
import { migrate4 } from './migrate4.js';
import { migrate5 } from './migrate5.js';
import { migrate6 } from './migrate6.js';
import { migrate7 } from './migrate7.js';
import { migrate8 } from './migrate8.js';
import { migrate9 } from './migrate9.js';
import { migrate10 } from './migrate10.js';
import { migrate11 } from './migrate11.js';
import { migrate12 } from './migrate12.js';
import { migrate13 } from './migrate13.js';
import { migrate14 } from './migrate14.js';
import { migrate15 } from './migrate15.js';
import { migrate16 } from './migrate16.js';
import { migrate17 } from './migrate17.js';

export const migrations = [
  { version: 1, up: migrate1 },
  { version: 2, up: migrate2 },
  { version: 3, up: migrate3 },
  { version: 4, up: migrate4 },
  { version: 5, up: migrate5 },
  { version: 6, up: migrate6 },
  { version: 7, up: migrate7 },
  { version: 8, up: migrate8 },
  { version: 9, up: migrate9 },
  { version: 10, up: migrate10 },
  { version: 11, up: migrate11 },
  { version: 12, up: migrate12 },
  { version: 13, up: migrate13 },
  { version: 14, up: migrate14 },
  { version: 15, up: migrate15 },
  { version: 16, up: migrate16 },
  { version: 17, up: migrate17 },
];
