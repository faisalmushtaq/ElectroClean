// Go to time (G): reading the time a person types, and where the view goes. Plain functions, so that
// Node can test them; the field itself is in workspace.js. What is typed is never logged, only the
// time it led to (docs/activity_logs.md, go_to_time).

const FORMS = 'Type seconds (12.5), minutes and seconds (1:05) or hours, minutes and seconds (1:02:05).';

/**
 * The time (seconds) in a typed text: seconds ("12.5", "12,5", "12.5 s"), m:ss ("1:05", "75:00.5")
 * or h:mm:ss ("1:02:05"). Returns {t} or {error} in plain words.
 */
export function parseTimeText(text) {
  const s = String(text ?? '').trim().replace(/\s*s(ec(onds?)?)?$/i, '').replace(/,/g, '.');
  if (!s) return { error: `Type a time to go to. ${FORMS}` };
  if (/^\d+(\.\d*)?$|^\.\d+$/.test(s)) return { t: Number(s) };
  let m = /^(\d+):(\d{1,2}(?:\.\d*)?)$/.exec(s);
  if (m) {
    const sec = Number(m[2]);
    if (sec >= 60) return { error: 'The seconds after a colon go up to 59, as in 1:05.' };
    return { t: Number(m[1]) * 60 + sec };
  }
  m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d*)?)$/.exec(s);
  if (m) {
    const min = Number(m[2]);
    const sec = Number(m[3]);
    if (min >= 60 || sec >= 60) return { error: 'The minutes and seconds after a colon go up to 59, as in 1:02:05.' };
    return { t: Number(m[1]) * 3600 + min * 60 + sec };
  }
  if (/^-/.test(s)) return { error: `Times start at 0, the beginning of the recording. ${FORMS}` };
  return { error: `ElectroTag cannot read that as a time. ${FORMS}` };
}

/** A time kept within the recording: {t, clamped}. */
export function clampTime(t, durationS) {
  const c = Math.min(Math.max(0, t), Math.max(0, durationS));
  return { t: c, clamped: c !== t };
}

/** Where the view starts to show time `t` in the middle of a screen `durationS` long (setView keeps it within the recording). */
export function centredStart(t, durationS) {
  return t - durationS / 2;
}
