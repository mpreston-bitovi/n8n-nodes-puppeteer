module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/nodes/**/*.test.ts'],
  testPathIgnorePatterns: ['<rootDir>/dist/'],
};
