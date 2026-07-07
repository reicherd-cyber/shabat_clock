import rateLimit from 'express-rate-limit';

// Tight limiter for credential endpoints (OTP request/verify, admin login) to
// slow brute-force of PINs/OTPs/passwords. Keyed by client IP.
export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});
