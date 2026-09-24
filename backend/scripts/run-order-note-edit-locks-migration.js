require("dotenv").config();

const { connectDatabase, getPool } = require("../src/config/database");

async function run() {
  await connectDatabase();
  const pool = getPool();

  const [tables] = await pool.query(
    `SELECT TABLE_NAME
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'order_note_edit_locks'`
  );

  if (!tables.length) {
    await pool.query(`
      CREATE TABLE order_note_edit_locks (
        note_id BIGINT UNSIGNED NOT NULL,
        order_id BIGINT UNSIGNED NOT NULL,
        employee_id BIGINT UNSIGNED NOT NULL,
        locked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        PRIMARY KEY (note_id),
        KEY idx_order_note_edit_locks_order (order_id),
        KEY idx_order_note_edit_locks_expires (expires_at)
      )
    `);
    console.log("Created order_note_edit_locks");
  } else {
    console.log("order_note_edit_locks already exists");
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
