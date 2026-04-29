/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/\\.claude/', '/\\.local/', '/worktrees/'],
  modulePathIgnorePatterns: ['<rootDir>/\\.claude/', '<rootDir>/\\.local/', '<rootDir>/worktrees/'],
  watchPathIgnorePatterns: ['<rootDir>/\\.claude/', '<rootDir>/\\.local/', '<rootDir>/worktrees/'],
  setupFiles: ['<rootDir>/tests/setup.js'],
  testTimeout: 15000,
};
