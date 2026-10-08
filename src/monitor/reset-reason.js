// Sys.GetStatus.reset_reason — the ESP-IDF esp_reset_reason code of the LAST
// boot, the only thing a Shelly remembers about why it restarted (no log
// survives on the unit). It separates "someone cut the power" from "the
// firmware died" — the question every reboot email used to leave open
// (2026-09-10: a Pro 4PM froze with a white screen, the customer power-cycled
// the board, and the record looked exactly like a mains cut). A manual
// power-cycle still reads POWERON, so a power reset of a frozen unit is
// indistinguishable from an outage — the email says so.
const RESET_REASONS = {
  1: { cat: 'power', he: 'הפעלת חשמל (POWERON) — הפסקת חשמל, או שמישהו כיבה והדליק את המכשיר' },
  2: { cat: 'power', he: 'איפוס חיצוני (EXT) — לחיצת כפתור איפוס' },
  3: { cat: 'software', he: 'אתחול תוכנה (SW) — עדכון קושחה או פקודת אתחול' },
  4: { cat: 'crash', he: 'קריסת קושחה (PANIC)' },
  5: { cat: 'crash', he: 'כלב שמירה — פסיקה (INT_WDT): הקושחה נתקעה' },
  6: { cat: 'crash', he: 'כלב שמירה — משימה (TASK_WDT): הקושחה נתקעה' },
  7: { cat: 'crash', he: 'כלב שמירה (WDT): הקושחה נתקעה' },
  8: { cat: 'software', he: 'יציאה משינה עמוקה (DEEPSLEEP)' },
  9: { cat: 'power', he: 'מתח נמוך (BROWNOUT) — נפילת מתח ברשת החשמל' },
  10: { cat: 'software', he: 'איפוס SDIO' },
  11: { cat: 'software', he: 'איפוס USB' },
  12: { cat: 'software', he: 'איפוס JTAG' },
  13: { cat: 'crash', he: 'שגיאת eFuse' },
  14: { cat: 'power', he: 'הפרעת מתח (PWR_GLITCH)' },
  15: { cat: 'crash', he: 'נעילת מעבד (CPU_LOCKUP): הקושחה נתקעה' },
};

export function describeReset(code) {
  if (typeof code !== 'number') return { cat: 'unknown', he: 'הקושחה לא מדווחת סיבת אתחול' };
  return RESET_REASONS[code] ?? { cat: 'unknown', he: `סיבת אתחול לא מוכרת (קוד ${code})` };
}

// Email subject suffix per category.
export const RESET_HEADLINE = {
  power: 'הפסקת חשמל (או כיבוי והדלקה ידניים)',
  crash: 'קריסת קושחה',
  software: 'אתחול יזום של הקושחה',
  unknown: 'קריסה או הפסקת חשמל',
};
