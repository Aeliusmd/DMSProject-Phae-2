require("dotenv").config();

const { connectDatabase, getPool } = require("../src/config/database");

async function run() {
  await connectDatabase();
  const pool = getPool();

  const [tables] = await pool.query(
    `SELECT TABLE_NAME
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'order_invoice_edit_locks'`
  );

  if (!tables.length) {
    await pool.query(`
      CREATE TABLE order_invoice_edit_locks (
        order_id BIGINT UNSIGNED NOT NULL,
        invoice_kind VARCHAR(16) NOT NULL,
        employee_id BIGINT UNSIGNED NOT NULL,
        locked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        PRIMARY KEY (order_id, invoice_kind),
        KEY idx_order_invoice_edit_locks_expires (expires_at)
      )
    `);
    console.log("Created order_invoice_edit_locks");
  } else {
    console.log("order_invoice_edit_locks already exists");
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
