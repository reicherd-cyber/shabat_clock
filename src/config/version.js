// Deployed version = the git commit the server runs (deploy.sh does git reset --hard,
// so HEAD is always the deployed state; local dev likewise). Computed once at boot.
import { execSync } from 'node:child_process';

function git(args) {
  try {
    return execSync(`git ${args}`, { timeout: 5000 }).toString().trim();
  } catch {
    return null;
  }
}

export const appVersion = {
  commit: git('rev-parse --short HEAD') || 'unknown',
  date: git('show -s --format=%cd --date="format:%d.%m.%Y %H:%M" HEAD') || '',
};
