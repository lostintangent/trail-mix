import { Database } from 'bun:sqlite';
import { upgrade, type Sql, type SqlValue } from './schema.ts';

/** The Mailroom's storage on Bun's SQLite, in memory and upgraded, for tests and benchmarks. */
export function testSql(): Sql {
  const db = new Database(':memory:');
  const sql: Sql = {
    all: <Row>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as Row[],
    run: (query, ...params) => void db.query(query).run(...params),
    transaction: (work) => db.transaction(work)(),
  };
  upgrade(sql);
  return sql;
}
