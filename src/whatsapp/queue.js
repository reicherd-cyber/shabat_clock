// One lane per key (2026-11-01): the webhook answers Meta at once and handles
// each message afterwards, so two messages from the same number used to run
// side by side — a voice note (seconds of download + transcription) and the
// text typed right after it could overwrite each other's confirmation state.
// serialByKey runs the jobs of one key strictly in arrival order; different
// keys still run in parallel. A failed job never blocks the next one.
const lanes = new Map();

export function serialByKey(key, job) {
  const prev = lanes.get(key) || Promise.resolve();
  const run = prev.then(job, job);
  const tail = run.catch(() => {});
  lanes.set(key, tail);
  tail.then(() => { if (lanes.get(key) === tail) lanes.delete(key); });
  return run;
}

export const pendingLanes = () => lanes.size;
