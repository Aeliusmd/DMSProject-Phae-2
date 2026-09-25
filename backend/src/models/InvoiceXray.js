const { getPool } = require("../config/database");

const ORDER_VISIBLE = "o.status NOT IN ('Cancelled', 'Deleted')";

const XRAY_AMOUNT_DUE_CONDITION =
  "GREATEST(0, COALESCE(x.payment, 0) - COALESCE(x.amount_paid, 0) - COALESCE(x.writeoff_amount, 0)) > 0";

const XRAY_OPEN_CONDITION = `(
  x.status <> 'Written Off'
  AND ${XRAY_AMOUNT_DUE_CONDITION}
)`;

const XRAY_INVOICE_SELECT = `
  SELECT x.*,
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
         o.serve_company_name,
         o.serve_email,
         o.applicant_first_name,
         o.applicant_middle_name,
         o.applicant_last_name,
         o.facility_id,
         o.provider_id,
         f.facility_name,
         f.email AS facility_email,
         p.email AS provider_email,
         p.company_name AS provider_name
  FROM invoice_xray_details x
  INNER JOIN orders o ON o.id = x.order_id
  INNER JOIN facilities f ON f.id = o.facility_id
  LEFT JOIN providers p ON p.id = o.provider_id`;

class InvoiceXray {
  static async findByOrderId(orderId, connection = null) {
    const db = connection || getPool();

    const [rows] = await db.execute(
      `${XRAY_INVOICE_SELECT}
       WHERE x.order_id = :orderId AND ${ORDER_VISIBLE}
       LIMIT 1`,
      { orderId }
    );

    return rows[0] || null;
  }

  static async lockRowByOrderId(connection, orderId) {
    const db = connection || getPool();
    const [rows] = await db.execute(
      `SELECT id
       FROM invoice_xray_details
       WHERE order_id = :orderId
       LIMIT 1
       FOR UPDATE`,
      { orderId }
    );
    return rows[0] || null;
  }

  static async findByOrderIds(orderIds = []) {
    if (!orderIds.length) return {};

    const pool = getPool();
    const placeholders = orderIds.map((_, index) => `:orderId${index}`).join(", ");
    const params = orderIds.reduce((acc, id, index) => {
      acc[`orderId${index}`] = id;
      return acc;
    }, {});

    const [rows] = await pool.execute(
      `SELECT *
       FROM invoice_xray_details
       WHERE order_id IN (${placeholders})`,
      params
    );

    return rows.reduce((acc, row) => {
      acc[row.order_id] = row;
      return acc;
    }, {});
  }

  static async findOutstanding(filters = {}) {
    const pool = getPool();
    const conditions = [
      ORDER_VISIBLE,
      "x.sent_date IS NULL",
      XRAY_OPEN_CONDITION,
    ];
    const params = {};

    if (filters.dateFrom) {
      conditions.push("x.xray_invoice_date >= :dateFrom");
      params.dateFrom = filters.dateFrom;
    }

    if (filters.dateTo) {
      conditions.push("x.xray_invoice_date <= :dateTo");
      params.dateTo = filters.dateTo;
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [rows] = await pool.execute(
      `${XRAY_INVOICE_SELECT}
       ${whereClause}
       ORDER BY f.facility_name ASC, x.xray_invoice_date ASC, o.order_number ASC`,
      params
    );

    return rows;
  }

  static async findByFacilityId(facilityId, filters = {}) {
    const pool = getPool();
    const conditions = [
      ORDER_VISIBLE,
      "o.facility_id = :facilityId",
      "x.sent_date IS NULL",
      XRAY_OPEN_CONDITION,
    ];
    const params = { facilityId };

    if (filters.dateFrom) {
      conditions.push("x.xray_invoice_date >= :dateFrom");
      params.dateFrom = filters.dateFrom;
    }

    if (filters.dateTo) {
      conditions.push("x.xray_invoice_date <= :dateTo");
      params.dateTo = filters.dateTo;
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [rows] = await pool.execute(
      `${XRAY_INVOICE_SELECT}
       ${whereClause}
       ORDER BY x.xray_invoice_date DESC, o.order_number ASC`,
      params
    );

    return rows;
  }

  static async findResendByFacilityId(facilityId, filters = {}) {
    const pool = getPool();
    const conditions = [
      ORDER_VISIBLE,
      "o.facility_id = :facilityId",
      "x.sent_date IS NOT NULL",
      XRAY_OPEN_CONDITION,
    ];
    const params = { facilityId };

    if (filters.dateFrom) {
      conditions.push("x.xray_invoice_date >= :dateFrom");
      params.dateFrom = filters.dateFrom;
    }

    if (filters.dateTo) {
      conditions.push("x.xray_invoice_date <= :dateTo");
      params.dateTo = filters.dateTo;
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [rows] = await pool.execute(
      `${XRAY_INVOICE_SELECT}
       ${whereClause}
       ORDER BY x.xray_invoice_date DESC, o.order_number ASC`,
      params
    );

    return rows;
  }

  static async findByProviderId(providerId, filters = {}) {
    const pool = getPool();
    const conditions = [
      ORDER_VISIBLE,
      "x.sent_date IS NULL",
      XRAY_OPEN_CONDITION,
    ];
    const params = {};

    if (providerId) {
      conditions.push("o.provider_id = :providerId");
      params.providerId = providerId;
    } else {
      conditions.push("o.provider_id IS NULL");
    }

    if (filters.dateFrom) {
      conditions.push("x.xray_invoice_date >= :dateFrom");
      params.dateFrom = filters.dateFrom;
    }

    if (filters.dateTo) {
      conditions.push("x.xray_invoice_date <= :dateTo");
      params.dateTo = filters.dateTo;
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [rows] = await pool.execute(
      `${XRAY_INVOICE_SELECT}
       ${whereClause}
       ORDER BY x.xray_invoice_date DESC, o.order_number ASC`,
      params
    );

    return rows;
  }

  static async findResendByProviderId(providerId, filters = {}) {
    const pool = getPool();
    const conditions = [
      ORDER_VISIBLE,
      "x.sent_date IS NOT NULL",
      XRAY_OPEN_CONDITION,
    ];
    const params = {};

    if (providerId) {
      conditions.push("o.provider_id = :providerId");
      params.providerId = providerId;
    } else {
      conditions.push("o.provider_id IS NULL");
    }

    if (filters.dateFrom) {
      conditions.push("x.xray_invoice_date >= :dateFrom");
      params.dateFrom = filters.dateFrom;
    }

    if (filters.dateTo) {
      conditions.push("x.xray_invoice_date <= :dateTo");
      params.dateTo = filters.dateTo;
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [rows] = await pool.execute(
      `${XRAY_INVOICE_SELECT}
       ${whereClause}
       ORDER BY x.xray_invoice_date DESC, o.order_number ASC`,
      params
    );

    return rows;
  }

  static async findResend(filters = {}) {
    const pool = getPool();
    const conditions = [
      ORDER_VISIBLE,
      "x.sent_date IS NOT NULL",
      XRAY_OPEN_CONDITION,
    ];
    const params = {};

    if (filters.dateFrom) {
      conditions.push("x.xray_invoice_date >= :dateFrom");
      params.dateFrom = filters.dateFrom;
    }

    if (filters.dateTo) {
      conditions.push("x.xray_invoice_date <= :dateTo");
      params.dateTo = filters.dateTo;
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [rows] = await pool.execute(
      `${XRAY_INVOICE_SELECT}
       ${whereClause}
       ORDER BY x.xray_invoice_date ASC, f.facility_name ASC`,
      params
    );

    return rows;
  }

  static async findByOrderIdsWithDetails(orderIds = []) {
    if (!orderIds.length) return [];

    const pool = getPool();
    const placeholders = orderIds.map((_, index) => `:orderId${index}`).join(", ");
    const params = orderIds.reduce((acc, id, index) => {
      acc[`orderId${index}`] = id;
      return acc;
    }, {});

    const [rows] = await pool.execute(
      `${XRAY_INVOICE_SELECT}
       WHERE x.order_id IN (${placeholders}) AND ${ORDER_VISIBLE}`,
      params
    );

    return rows;
  }

  static async upsert(connection, orderId, data) {
    const db = connection || getPool();

    await db.execute(
      `INSERT INTO invoice_xray_details (
         order_id, invoice_number, xray_invoice_date, exam_date,
         view_count, per_view_amount, payment,
         check_number, description, recipient_emails,
         created_at, updated_at
       ) VALUES (
         :orderId, :invoiceNumber, :xrayInvoiceDate, :examDate,
         :viewCount, :perViewAmount, :payment,
         :checkNumber, :description, :recipientEmails,
         NOW(), NOW()
       )
       ON DUPLICATE KEY UPDATE
         invoice_number = COALESCE(invoice_number, VALUES(invoice_number)),
         xray_invoice_date = VALUES(xray_invoice_date),
         exam_date = VALUES(exam_date),
         view_count = VALUES(view_count),
         per_view_amount = VALUES(per_view_amount),
         payment = VALUES(payment),
         check_number = VALUES(check_number),
         description = VALUES(description),
         recipient_emails = VALUES(recipient_emails),
         updated_at = NOW()`,
      {
        orderId,
        invoiceNumber: data.invoiceNumber ?? null,
        xrayInvoiceDate: data.xrayInvoiceDate,
        examDate: data.examDate,
        viewCount: data.viewCount,
        perViewAmount: data.perViewAmount,
        payment: data.payment,
        checkNumber: data.checkNumber,
        description: data.description,
        recipientEmails: data.recipientEmails ?? null,
      }
    );
  }

  static async markAsSent(orderId, sentDate = null, connection = null) {
    const db = connection || getPool();

    const [result] = await db.execute(
      `UPDATE invoice_xray_details
       SET sent_date = COALESCE(:sentDate, NOW()), updated_at = NOW()
       WHERE order_id = :orderId
         AND sent_date IS NULL`,
      { orderId, sentDate }
    );

    return result.affectedRows;
  }

  static async writeOff(connection, orderId, data) {
    const db = connection || getPool();

    await db.execute(
      `UPDATE invoice_xray_details SET
         status = :status,
         writeoff_amount = :writeoffAmount,
         writeoff_date = :writeoffDate,
         writeoff_by = :writeoffBy,
         writeoff_reason = :writeoffReason,
         updated_at = NOW()
       WHERE order_id = :orderId`,
      { ...data, orderId }
    );
  }
}

module.exports = InvoiceXray;
