import pg from "pg";
import { config } from "./config";

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
        await c.query("BEGIN");
        const result = await fn(c);
        await c.query("COMMIT");
        return result;
    } catch (err) {
        await c.query("ROLLBACK");
        throw err;
    } finally {
        c.release();
    }
}