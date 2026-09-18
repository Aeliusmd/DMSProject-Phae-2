const { getPool } = require("../config/database");
const { likeContains, likePrefix } = require("../utils/sqlSafety");

const ACTIVITY_LOG_SELECT = `al.id, al.log_date, al.log_time, al.action, al.module, al.company_name, al.facility_id,
              al.performed_by, al.performer_name, al.performer_initials, al.details, al.created_at,
              e.role AS performer_role`;

const ACTIVITY_LOG_FROM = `activity_logs al
       LEFT JOIN matrix_employees e ON e.id = al.performed_by`;

const ACTIVITY_LOG_INSTANT_SQL = `TIMESTAMP(CONCAT(al.log_date, ' ', COALESCE(NULLIF(TRIM(al.log_time), ''), '00:00:00')))`;

function buildFindByEmployeeWhere(employeeId, filters = {}) {
  const params = {
    employeeId,
    targetTag: `%target_employee_id:${Number(employeeId)}%`,
  };
  const conditions = ["(al.performed_by = :employeeId OR al.details LIKE :targetTag)"];

  if (filters.search) {
    const trimmedSearch = `${filters.search}`.trim();
    if (trimmedSearch) {
      conditions.push(`(
        al.performer_name LIKE :search
        OR al.action LIKE :search
        OR al.details LIKE :search
        OR al.module LIKE :search
      )`);
      params.search = likeContains(trimmedSearch);
    }
  }

  return {
    whereClause: `WHERE ${conditions.join(" AND ")}`,
    params,
  };
}

function buildFindAllWhere(filters = {}) {
  const conditions = [];
  const params = {};

  if (filters.performedBy) {
    conditions.push("al.performed_by = :performedBy");
    params.performedBy = filters.performedBy;
  }

  if (filters.module) {
    conditions.push("al.module = :module");
    params.module = filters.module;
  }

  // Prefer timezone-aware instant bounds when provided (viewer calendar day).
  if (filters.fromLoggedAt) {
    conditions.push(`${ACTIVITY_LOG_INSTANT_SQL} >= :fromLoggedAt`);
    params.fromLoggedAt = filters.fromLoggedAt;
  } else if (filters.fromDate) {
    conditions.push("al.log_date >= :fromDate");
    params.fromDate = filters.fromDate;
  }

  if (filters.toLoggedAt) {
    conditions.push(`${ACTIVITY_LOG_INSTANT_SQL} <= :toLoggedAt`);
    params.toLoggedAt = filters.toLoggedAt;
  } else if (filters.toDate) {
    conditions.push("al.log_date <= :toDate");
    params.toDate = filters.toDate;
  }

  if (filters.search) {
    conditions.push("al.performer_name LIKE :searchPrefix");
    params.searchPrefix = likePrefix(filters.search);
  }

  return {
    whereClause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

class ActivityLog {
  static async create(data) {
    const pool = getPool();

    const [result] = await pool.execute(
      `INSERT INTO activity_logs (
        log_date, log_time, action, module, company_name, facility_id,
        performed_by, performer_name, performer_initials, details, created_at
      ) VALUES (
        :logDate, :logTime, :action, :module, :companyName, :facilityId,
        :performedBy, :performerName, :performerInitials, :details, NOW()
      )`,
      data
    );

    return result.insertId;
  }

  static async findByPerformerId(employeeId, { limit = 200 } = {}) {
    const pool = getPool();

    const [rows] = await pool.execute(
      `SELECT ${ACTIVITY_LOG_SELECT}
       FROM ${ACTIVITY_LOG_FROM}
       WHERE al.performed_by = :employeeId
       ORDER BY al.created_at DESC, al.id DESC
       LIMIT ${Number(limit)}`,
      { employeeId }
    );

    return rows;
  }

  static async findByEmployeeId(employeeId, { limit = 200 } = {}) {
    const pool = getPool();
    const { whereClause, params } = buildFindByEmployeeWhere(employeeId);

    const [rows] = await pool.execute(
      `SELECT ${ACTIVITY_LOG_SELECT}
       FROM ${ACTIVITY_LOG_FROM}
       ${whereClause}
       ORDER BY al.id DESC
       LIMIT ${Number(limit)}`,
      params
    );

    return rows;
  }

  static async findByEmployeeIdKeyset(employeeId, filters = {}) {
    const pool = getPool();
    const { whereClause, params } = buildFindByEmployeeWhere(employeeId, filters);
    const pageSize = Math.min(Math.max(Number(filters.pageSize) || 10, 1), 100);
    const queryLimit = pageSize + 1;
    const cursorId =
      Number(filters.cursorId) > 0 ? Number(filters.cursorId) : null;
    const cursorCondition = cursorId ? "al.id < :cursorId" : "";

    if (cursorId) {
      params.cursorId = cursorId;
    }

    const keysetWhereClause = cursorCondition
      ? `${whereClause} AND ${cursorCondition}`
      : whereClause;

    const [rows] = await pool.execute(
      `SELECT ${ACTIVITY_LOG_SELECT}
       FROM ${ACTIVITY_LOG_FROM}
       ${keysetWhereClause}
       ORDER BY al.id DESC
       LIMIT ${queryLimit}`,
      params
    );

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

    if (cursorId && !pageRows.length) {
      return {
        rows: pageRows,
        pageSize,
        hasMore: false,
        nextCursor: null,
      };
    }

    const nextCursor = hasMore ? pageRows[pageRows.length - 1]?.id || null : null;

    return {
      rows: pageRows,
      pageSize,
      hasMore,
      nextCursor,
    };
  }

  static async findAll(filters = {}) {
    const pool = getPool();
    const { whereClause, params } = buildFindAllWhere(filters);
    const limit =
      filters.limit && Number(filters.limit) > 0
        ? Math.min(Number(filters.limit), 500)
        : 500;

    const [rows] = await pool.execute(
      `SELECT ${ACTIVITY_LOG_SELECT}
       FROM ${ACTIVITY_LOG_FROM}
       ${whereClause}
       ORDER BY al.id DESC
       LIMIT ${limit}`,
      params
    );

    return rows;
  }

  static async findAllKeyset(filters = {}) {
    const pool = getPool();
    const { whereClause, params } = buildFindAllWhere(filters);
    const pageSize = Math.min(Math.max(Number(filters.pageSize) || 10, 1), 100);
    const queryLimit = pageSize + 1;
    const cursorId =
      Number(filters.cursorId) > 0 ? Number(filters.cursorId) : null;
    const cursorCondition = cursorId ? "al.id < :cursorId" : "";

    if (cursorId) {
      params.cursorId = cursorId;
    }

    const keysetWhereClause = cursorCondition
      ? whereClause
        ? `${whereClause} AND ${cursorCondition}`
        : `WHERE ${cursorCondition}`
      : whereClause;

    const [rows] = await pool.execute(
      `SELECT ${ACTIVITY_LOG_SELECT}
       FROM ${ACTIVITY_LOG_FROM}
       ${keysetWhereClause}
       ORDER BY al.id DESC
       LIMIT ${queryLimit}`,
      params
    );

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;

    if (cursorId && !pageRows.length) {
      return {
        rows: pageRows,
        pageSize,
        hasMore: false,
        nextCursor: null,
      };
    }

    const nextCursor = hasMore ? pageRows[pageRows.length - 1]?.id || null : null;

    return {
      rows: pageRows,
      pageSize,
      hasMore,
      nextCursor,
    };
  }

  static async findById(id) {
    const pool = getPool();

    const [rows] = await pool.execute(
      `SELECT ${ACTIVITY_LOG_SELECT}
       FROM ${ACTIVITY_LOG_FROM}
       WHERE al.id = :id
       LIMIT 1`,
      { id }
    );

    return rows[0] || null;
  }

  static async findByOrderId(orderId, { limit = 200, orderNumber = null } = {}) {
    const pool = getPool();
    const normalizedOrderId = Number(orderId);
    const orderTag = `%order_id:${normalizedOrderId}%`;
    const conditions = ["al.details LIKE :orderTag"];
    const params = { orderTag };

    if (orderNumber) {
      conditions.push(
        "(al.module = 'Orders' AND (al.details LIKE :orderNumberTag OR al.details LIKE :orderLabelTag))"
      );
      params.orderNumberTag = likeContains(orderNumber);
      params.orderLabelTag = likeContains(`order ${orderNumber}`);
    }

    const [rows] = await pool.execute(
      `SELECT ${ACTIVITY_LOG_SELECT}
       FROM ${ACTIVITY_LOG_FROM}
       WHERE ${conditions.join(" OR ")}
       ORDER BY al.created_at DESC, al.id DESC
       LIMIT ${Number(limit)}`,
      params
    );

    return rows;
  }
}

module.exports = ActivityLog;
