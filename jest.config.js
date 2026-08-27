export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/src/__tests__/setup-env.ts'],
  // Instruments the dispatcher to record which tools the suite actually runs. Inert unless
  // PREMIERE_MCP_TOOL_COVERAGE=1, so an ordinary run pays nothing and cannot fail because of it.
  // Must be setupFilesAfterEnv rather than setupFiles: the probe reads expect.getState() to
  // attribute each invocation to a test file, and expect does not exist in setupFiles.
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/tool-coverage-probe.ts'],
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
    }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  testTimeout: 10000,
  verbose: true,
  transformIgnorePatterns: [
    'node_modules/(?!(@modelcontextprotocol)/)',
  ],
};
