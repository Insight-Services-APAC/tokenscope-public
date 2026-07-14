import { defineConfig } from 'drizzle-kit'

// TokenScope — Drizzle migration config.
//
// Schema lives in drizzle/schema/index.ts (barrel for per-domain modules).
// Migrations are versioned in drizzle/migrations/. The 0000 prelude is
// hand-written (the required PostgreSQL extensions per data-model.md
// §Required PostgreSQL extensions); Drizzle generates 0001+ from schema
// diffs (`npm run db:generate`).
export default defineConfig({
  schema: './drizzle/schema/index.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://tokenscope:tokenscope@localhost:5432/tokenscope',
  },
  casing: 'snake_case',
})
