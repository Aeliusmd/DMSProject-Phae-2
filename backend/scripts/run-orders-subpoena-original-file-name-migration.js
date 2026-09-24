require("dotenv").config();

const { connectDatabase, getPool } = require("../src/config/database");

async function run() {
  await connectDatabase();
  const pool = getPool();

  const [cols] = await pool.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'orders'
       AND COLUMN_NAME = 'subpoena_original_file_name'`
  );

  if (!cols.length) {
    await pool.query(
      `ALTER TABLE orders
       ADD COLUMN subpoena_original_file_name VARCHAR(255) NULL
         COMMENT 'Original uploaded subpoena file name for display/download'
         AFTER subpoena_storage_path`
    );
    console.log("Added orders.subpoena_original_file_name");
  } else {
    console.log("orders.subpoena_original_file_name already exists");
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
