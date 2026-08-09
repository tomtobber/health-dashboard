const fs = require('fs');
const path = require('path');

function write(filePath, content) {
  const fullPath = path.join(__dirname, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content.trim() + '\n', 'utf8');
  console.log('Created:', filePath);
}

// 1. package.json
write('package.json', JSON.stringify({
  name: 'personal-health-dashboard',
  version: '1.0.0',
  description: 'Personal Health Dashboard - Aggregates health & lifestyle metrics',
  main: 'dist/server.js',
  scripts: {
    build: 'tsc',
    start: 'node dist/server.js',
    dev: 'tsx watch src/server.ts',
    'db:generate': 'drizzle-kit generate',
    'db:push': 'drizzle-kit push',
    test: 'jest --runInBand'
  },
  dependencies: {
    bcryptjs: '^2.4.3',
    cors: '^2.8.5',
    dotenv: '^16.4.5',
    'drizzle-orm': '^0.33.0',
    express: '^4.19.2',
    googleapis: '^140.0.0',
    jsonwebtoken: '^9.0.2',
    pg: '^8.12.0',
    zod: '^3.23.8'
  },
  devDependencies: {
    '@types/bcryptjs': '^2.4.6',
    '@types/cors': '^2.8.17',
    '@types/express': '^4.17.21',
    '@types/jest': '^29.5.12',
    '@types/jsonwebtoken': '^9.0.6',
    '@types/node': '^20.14.9',
    '@types/pg': '^8.11.6',
    '@types/supertest': '^6.0.2',
    'drizzle-kit': '^0.24.0',
    jest: '^29.7.0',
    supertest: '^7.0.0',
    'ts-jest': '^29.1.5',
    tsx: '^4.16.2',
    typescript: '^5.5.2'
  }
}, null, 2));

// 2. tsconfig.json
write('tsconfig.json', JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'CommonJS',
    moduleResolution: 'node',
    lib: ['ES2022'],
    outDir: './dist',
    rootDir: './src',
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
    declaration: true
  },
  include: ['src/**/*']
}, null, 2));

// 3. jest.config.js
write('jest.config.js', `module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  transform: {
    '^.+\\\\.tsx?$': ['ts-jest', { tsconfig: { module: 'commonjs', moduleResolution: 'node' } }]
  }
};`);

// 4. .env.example
write('.env.example', `PORT=3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/health_dashboard
JWT_SECRET=super-secret-jwt-key-min-32-chars-length
ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
GOOGLE_CLIENT_ID=mock-google-client-id
GOOGLE_CLIENT_SECRET=mock-google-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/api/connect/google/callback
APP_BASE_URL=http://localhost:3000`);

// 5. .env
write('.env', `PORT=3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/health_dashboard
JWT_SECRET=super-secret-jwt-key-min-32-chars-length
ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
GOOGLE_CLIENT_ID=mock-google-client-id
GOOGLE_CLIENT_SECRET=mock-google-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/api/connect/google/callback
APP_BASE_URL=http://localhost:3000`);

// 6. drizzle.config.ts
write('drizzle.config.ts', `import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';
dotenv.config();

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/health_dashboard',
  },
});`);

console.log('Setup script ready.');
