import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

export function createTestDatabase() {
  const connection = new DatabaseSync(":memory:");
  const migrations = new URL("../../drizzle/", import.meta.url);
  for (const file of readdirSync(migrations).filter(f => f.endsWith(".sql")).sort()) connection.exec(readFileSync(new URL(file, migrations), "utf8"));
  return {
    connection,
    prepare(sql) {
      let params = [];
      const statement = { bind(...values) { params = values; return statement; }, async first() { return connection.prepare(sql).get(...params) || null; }, async all() { return { results: connection.prepare(sql).all(...params) }; }, run() { return { meta: connection.prepare(sql).run(...params) }; } };
      return statement;
    },
    async batch(statements) {
      connection.exec("BEGIN");
      try { const result = statements.map(s => s.run()); connection.exec("COMMIT"); return result; }
      catch (error) { connection.exec("ROLLBACK"); throw error; }
    },
  };
}
