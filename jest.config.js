// jest.config.js
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.spec.js','<rootDir>/test/*.spec.js'],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/tests/',
  ],
  moduleFileExtensions: ['js', 'json', 'node'],
  transform: {},
};