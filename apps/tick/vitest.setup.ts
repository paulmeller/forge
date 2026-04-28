// Stub env vars before any module reads process.env at load time. These
// values are never reached because tests exercise pure functions; they
// just keep src/env.ts from throwing during import.
process.env.DATABASE_URL ||= 'file:./test-noop.db';
process.env.PORT ||= '8080';
