/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/\\.claude/', '/\\.local/'],
  modulePathIgnorePatterns: ['<rootDir>/\\.claude/', '<rootDir>/\\.local/'],
  watchPathIgnorePatterns: ['<rootDir>/\\.claude/', '<rootDir>/\\.local/'],
  setupFiles: ['<rootDir>/tests/setup.js'],
  testTimeout: 15000,
};
