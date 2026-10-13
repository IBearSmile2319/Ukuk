module.exports = {
  testEnvironment: 'node',
  rootDir: '..',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { isolatedModules: true }] },
  testTimeout: 30000,
};
