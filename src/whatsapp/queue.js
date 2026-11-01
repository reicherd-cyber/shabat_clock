// One lane per key (2026-11-01): the webhook answers Meta at once and handles
// each message afterwards, so two messages from the same number used to run
// side by side — a voice note (seconds of download + transcription) and the
// text typed right after it could overwrite each other's confirmation state.
// serialByKey runs the jobs of one key strictly in arrival order; different
// keys still run in parallel. A failed job never blocks the next one.
const lanes = new Map(); // key → { tail: Promise, pending: number }

// `max`: how many jobs may wait in one lane; past it the job is refused with
// an error whose code is QUEUE_FULL (a flood must not pile up paid work).
export function serialByKey(key, job, { max = 20 } = {}) {
  const lane = lanes.get(key) || { tail: Promise.resolve(), pending: 0 };
  if (lane.pending >= max) return Promise.reject(Object.assign(new Error(`queue full for ${key}`), { code: 'QUEUE_FULL' }));
  lane.pending += 1;
  const run = lane.tail.then(job, job);
  const tail = run.catch(() => {}).then(() => { lane.pending -= 1; });
  lane.tail = tail;
  lanes.set(key, lane);
  tail.then(() => { if (lanes.get(key) === lane && lane.pending === 0) lanes.delete(key); });
  return run;
}

export const pendingLanes = () => lanes.size;
export const pendingIn = (key) => lanes.get(key)?.pending ?? 0;
