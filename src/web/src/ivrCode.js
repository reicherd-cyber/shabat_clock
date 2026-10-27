// The IVR code rule as the browser sees it — mirrors src/services/ivrCode.js
// (the server validates; this only sizes the inputs and the wizard's proposals).
export const IVR_DIGIT_MAX = 999;
export const IVR_DIGIT_WIDTH = String(IVR_DIGIT_MAX).length;
