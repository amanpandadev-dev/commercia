import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Password hashing is made cheap here (2^12) so the suite is fast; tests/passwords.test.ts checks the real default (2^17).
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20000, env: { COMMERCIA_SCRYPT_LOG2: '12' } },
});
