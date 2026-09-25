const { getPool } = require("../config/database");

const ORDER_VISIBLE = "o.status NOT IN ('Cancelled', 'Deleted')";

const INVOICE_SELECT = `
  SELECT i.*,
         o.order_number,
         o.case_number,
         o.defendant,
         (SELECT GROUP_CONCAT(
            DISTINCT r.record_type
            ORDER BY FIELD(r.record_type, 'medical', 'billing', 'employment', 'xrays', 'other')
            SEPARATOR ','
          )
          FROM order_records r
          WHERE r.order_id = o.id) AS order_record_types,
         o.subpoena_date,
         o.created_at AS order_created_at,
         o.depo_due_date,
         o.date_served,
         o.serve_company_name,
         o.serve_address,
         o.serve_city,
         o.serve_state,
         o.serve_zip,
         o.serve_email,
         o.specific_record,
         o.specific_doctor,
         o.applicant_first_name,
         o.applicant_middle_name,
         o.applicant_last_name,
         o.provider_id,
         f.facility_name,
         f.email AS facility_email,
         p.email AS provider_email,
         p.company_name AS provider_name
  FROM invoices i
  INNER JOIN orders o ON o.id = i.order_id
  INNER JOIN facilities f ON f.id = i.facility_id
  LEFT JOIN providers p ON p.id = o.provider_id`;

class Invoice {
  static async findById(id) {
    const pool = getPool();

    const [rows] = await pool.execute(
      `${INVOICE_SELECT}
       WHERE i.id = :id AND ${ORDER_VISIBLE}
       LIMIT 1`,
      { id }
    );

    return rows[0] || null;
  }

  static async lockRowById(connection, id) {
    const db = connection || getPool();
    const [rows] = await db.execute(
      `SELECT id
       FROM invoices
       WHERE id = :id
       LIMIT 1
       FOR UPDATE`,
      { id }
    );
    return rows[0] || null;
  }

  static async findByOrderId(orderId, connection = null) {
    const db = connection || getPool();

    const [rows] = await db.execute(
      `${INVOICE_SELECT}
       WHERE i.order_id = :orderId AND ${ORDER_VISIBLE}
       ORDER BY i.id DESC
       LIMIT 1`,
      { orderId }
    );

    return rows[0] || null;
  }

  static async findByOrderIds(orderIds = []) {
    if (!orderIds.length) return [];

    const pool = getPool();
    const placeholders = orderIds.map((_, index) => `:orderId${index}`).join(", ");
    const params = orderIds.reduce((acc, id, index) => {
      acc[`orderId${index}`] = id;
      return acc;
    }, {});

    const [rows] = await pool.execute(
      `${INVOICE_SELECT}
       WHERE i.order_id IN (${placeholders}) AND ${ORDER_VISIBLE}
       ORDER BY i.id DESC`,
      params
    );

    const byOrderId = {};
    rows.forEach((row) => {
      if (!byOrderId[row.order_id]) {
        byOrderId[row.order_id] = row;
      }
    });

    return byOrderId;
  }

  static async findOutstanding(filters = {}) {
    const pool = getPool();
    const conditions = [
      ORDER_VISIBLE,
      "i.status NOT IN ('Paid', 'Written Off', 'Needs Resend')",
      "i.sent_date IS NULL",
      "i.amount_due > 0",
    ];
    const params = {};

    if (filters.dateFrom) {
      conditions.push("i.invoice_date >= :dateFrom");
      params.dateFrom = filters.dateFrom;
    }

    if (filters.dateTo) {
      conditions.push("i.invoice_date <= :dateTo");
      params.dateTo = filters.dateTo;
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [rows] = await pool.execute(
      `${INVOICE_SELECT}
       ${whereClause}
       ORDER BY f.facility_name ASC, i.invoice_date ASC, o.order_number ASC`,
      params
    );

    return rows;
  }

  static async findResend(filters = {}) {
    const pool = getPool();
    const conditions = [
      ORDER_VISIBLE,
      "i.status <> 'Paid'",
      "i.amount_due > 0",
      `(
        i.status = 'Needs Resend'
        OR (
          i.sent_date IS NOT NULL
          AND i.status <> 'Written Off'
        )
      )`,
    ];
    const params = {};

    if (filters.dateFrom) {
      conditions.push("i.invoice_date >= :dateFrom");
      params.dateFrom = filters.dateFrom;
    }

    if (filters.dateTo) {
      conditions.push("i.invoice_date <= :dateTo");
      params.dateTo = filters.dateTo;
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [rows] = await pool.execute(
      `${INVOICE_SELECT}
       ${whereClause}
       ORDER BY i.invoice_date ASC, f.facility_name ASC`,
      params
    );

    return rows;
  }

  static async findByFacilityId(facilityId, filters = {}) {
    const pool = getPool();
    const conditions = [
      ORDER_VISIBLE,
      "i.facility_id = :facilityId",
      "i.status NOT IN ('Paid', 'Written Off', 'Needs Resend')",
      "i.sent_date IS NULL",
      "i.amount_due > 0",
    ];
    const params = { facilityId };

    if (filters.dateFrom) {
      conditions.push("i.invoice_date >= :dateFrom");
      params.dateFrom = filters.dateFrom;
    }

    if (filters.dateTo) {
      conditions.push("i.invoice_date <= :dateTo");
      params.dateTo = filters.dateTo;
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [rows] = await pool.execute(
      `${INVOICE_SELECT}
       ${whereClause}
       ORDER BY i.invoice_date DESC, o.order_number ASC`,
      params
    );

    return rows;
  }

  static async findResendByFacilityId(facilityId, filters = {}) {
    const pool = getPool();
    const conditions = [
      ORDER_VISIBLE,
      "i.facility_id = :facilityId",
      "i.status <> 'Paid'",
      "i.amount_due > 0",
      `(
        i.status = 'Needs Resend'
        OR (
          i.sent_date IS NOT NULL
          AND i.status <> 'Written Off'
        )
      )`,
    ];
    const params = { facilityId };

    if (filters.dateFrom) {
      conditions.push("i.invoice_date >= :dateFrom");
      params.dateFrom = filters.dateFrom;
    }

    if (filters.dateTo) {
      conditions.push("i.invoice_date <= :dateTo");
      params.dateTo = filters.dateTo;
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [rows] = await pool.execute(
      `${INVOICE_SELECT}
       ${whereClause}
       ORDER BY i.invoice_date DESC, o.order_number ASC`,
      params
    );

    return rows;
  }

  static async findByProviderId(providerId, filters = {}) {
    const pool = getPool();
    const conditions = [
      ORDER_VISIBLE,
      "i.status NOT IN ('Paid', 'Written Off', 'Needs Resend')",
      "i.sent_date IS NULL",
      "i.amount_due > 0",
    ];
    const params = {};

    if (providerId) {
      conditions.push("o.provider_id = :providerId");
      params.providerId = providerId;
    } else {
      conditions.push("o.provider_id IS NULL");
    }

    if (filters.dateFrom) {
      conditions.push("i.invoice_date >= :dateFrom");
      params.dateFrom = filters.dateFrom;
    }

    if (filters.dateTo) {
      conditions.push("i.invoice_date <= :dateTo");
      params.dateTo = filters.dateTo;
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [rows] = await pool.execute(
      `${INVOICE_SELECT}
       ${whereClause}
       ORDER BY i.invoice_date DESC, o.order_number ASC`,
      params
    );

    return rows;
  }

  static async findResendByProviderId(providerId, filters = {}) {
    const pool = getPool();
    const conditions = [
      ORDER_VISIBLE,
      "i.status <> 'Paid'",
      "i.amount_due > 0",
      `(
        i.status = 'Needs Resend'
        OR (
          i.sent_date IS NOT NULL
          AND i.status <> 'Written Off'
        )
      )`,
    ];
    const params = {};

    if (providerId) {
      conditions.push("o.provider_id = :providerId");
      params.providerId = providerId;
    } else {
      conditions.push("o.provider_id IS NULL");
    }

    if (filters.dateFrom) {
      conditions.push("i.invoice_date >= :dateFrom");
      params.dateFrom = filters.dateFrom;
    }

    if (filters.dateTo) {
      conditions.push("i.invoice_date <= :dateTo");
      params.dateTo = filters.dateTo;
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [rows] = await pool.execute(
      `${INVOICE_SELECT}
       ${whereClause}
       ORDER BY i.invoice_date DESC, o.order_number ASC`,
      params
    );

    return rows;
  }

  static async create(connection, data) {
    const db = connection || getPool();

    const [result] = await db.execute(
      `INSERT INTO invoices (
         invoice_number, order_id, facility_id, status,
         invoice_date, sent_date,
         page_count, per_page_amount,
         clerical_time_hours, clerical_hourly_rate, shipping_handling, storage_fee,
         total_amount, amount_paid, amount_due,
         notes, send_order_details, is_rush_order, recipient_emails, created_by,
         created_at, updated_at
       ) VALUES (
         :invoiceNumber, :orderId, :facilityId, :status,
         :invoiceDate, :sentDate,
         :pageCount, :perPageAmount,
         :clericalTimeHours, :clericalHourlyRate, :shippingHandling, :storageFee,
         :totalAmount, :amountPaid, :amountDue,
         :notes, :sendOrderDetails, :isRushOrder, :recipientEmails, :createdBy,
         NOW(), NOW()
       )`,
      data
    );

    return result.insertId;
  }

  static async update(connection, id, data) {
    const db = connection || getPool();

    await db.execute(
      `UPDATE invoices SET
         status = :status,
         invoice_date = :invoiceDate,
         sent_date = :sentDate,
         page_count = :pageCount,
         per_page_amount = :perPageAmount,
         clerical_time_hours = :clericalTimeHours,
         clerical_hourly_rate = :clericalHourlyRate,
         shipping_handling = :shippingHandling,
         storage_fee = :storageFee,
         total_amount = :totalAmount,
         amount_paid = :amountPaid,
         amount_due = :amountDue,
         notes = :notes,
         send_order_details = :sendOrderDetails,
         is_rush_order = :isRushOrder,
         recipient_emails = :recipientEmails,
         updated_at = NOW()
       WHERE id = :id`,
      { ...data, id }
    );
  }

  static async findByIds(ids = []) {
    if (!ids.length) return [];

    const pool = getPool();
    const placeholders = ids.map((_, index) => `:id${index}`).join(", ");
    const params = ids.reduce((acc, id, index) => {
      acc[`id${index}`] = id;
      return acc;
    }, {});

    const [rows] = await pool.execute(
      `SELECT id, sent_date, status, amount_due
       FROM invoices
       WHERE id IN (${placeholders})`,
      params
    );

    return rows;
  }

  static async findDetailsByIds(ids = []) {
    if (!ids.length) return [];

    const pool = getPool();
    const placeholders = ids.map((_, index) => `:id${index}`).join(", ");
    const params = ids.reduce((acc, id, index) => {
      acc[`id${index}`] = id;
      return acc;
    }, {});

    const [rows] = await pool.execute(
      `${INVOICE_SELECT}
       WHERE i.id IN (${placeholders}) AND ${ORDER_VISIBLE}`,
      params
    );

    return rows;
  }

  static async writeOff(connection, id, data) {
    const db = connection || getPool();

    await db.execute(
      `UPDATE invoices SET
         status = :status,
         amount_due = :amountDue,
         writeoff_amount = :writeoffAmount,
         writeoff_date = :writeoffDate,
         writeoff_by = :writeoffBy,
         writeoff_reason = :writeoffReason,
         updated_at = NOW()
       WHERE id = :id`,
      { ...data, id }
    );
  }

  static async markAsSent(ids = [], sentDate = null) {
    if (!ids.length) return 0;

    const pool = getPool();
    const placeholders = ids.map((_, index) => `:id${index}`).join(", ");
    const params = ids.reduce((acc, id, index) => {
      acc[`id${index}`] = id;
      return acc;
    }, {});
    params.sentDate = sentDate;

    const [result] = await pool.execute(
      `UPDATE invoices
       SET sent_date = COALESCE(:sentDate, NOW()),
           updated_at = NOW()
       WHERE id IN (${placeholders})
         AND sent_date IS NULL`,
      params
    );

    return result.affectedRows || 0;
  }

  static async markAsEmailSent(ids = [], sentDate = null) {
    if (!ids.length) return 0;

    const pool = getPool();
    const placeholders = ids.map((_, index) => `:id${index}`).join(", ");
    const params = ids.reduce((acc, id, index) => {
      acc[`id${index}`] = id;
      return acc;
    }, {});
    params.sentDate = sentDate;

    const [result] = await pool.execute(
      `UPDATE invoices
       SET sent_date = COALESCE(:sentDate, NOW()),
           status = CASE
             WHEN status IN ('Paid', 'Partial', 'Unpaid', 'Written Off') THEN status
             ELSE 'Needs Resend'
           END,
           updated_at = NOW()
       WHERE id IN (${placeholders})`,
      params
    );

    return result.affectedRows || 0;
  }

  static async markAsResent(ids = []) {
    return Invoice.markAsEmailSent(ids);
  }
}

module.exports = Invoice;
