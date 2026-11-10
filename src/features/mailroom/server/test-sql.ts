import { Database } from 'bun:sqlite';
import { upgrade, type Sql, type SqlValue } from './schema.ts';

/**
 * The Mailroom's storage on Bun's SQLite, in memory and upgraded, for tests and benchmarks. Given a
 * version, it stops there, as a Mailroom from that release would be.
 */
export function testSql(version?: number): Sql {
  const db = new Database(':memory:');
  const sql: Sql = {
    all: <Row>(query: string, ...params: SqlValue[]) => db.query(query).all(...params) as Row[],
    each: <Row>(query: string, ...params: SqlValue[]) =>
      db.query(query).iterate(...params) as Iterable<Row>,
    run: (query, ...params) => void db.query(query).run(...params),
    transaction: (work) => db.transaction(work)(),
  };
  upgrade(sql, version);
  return sql;
}
