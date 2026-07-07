// [D8] Phone normalization: strip non-digits; +972XX / 972XX → 0XX.
// Applied at every write AND at caller-ID lookup so both sides compare the same form.
export function normalizePhone(raw) {
  if (raw == null) return '';
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('972')) digits = '0' + digits.slice(3);
  return digits;
}

export function isValidIsraeliPhone(phone) {
  return /^0\d{8,9}$/.test(phone);
}
