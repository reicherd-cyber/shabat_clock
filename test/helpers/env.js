// Test env — set BEFORE any src import (env.js throws on missing vars).
process.env.DATABASE_URL ??= 'mysql://test:test@localhost:3306/shabat_clock_test';
process.env.IVR_TOKEN ??= 'test-token';
process.env.JWT_SECRET ??= 'test-secret';
process.env.NODE_ENV = 'test';
