const { getPool } = require("../config/database");
const { rethrowServiceError } = require("../utils/serviceErrorUtils");
const {
  normalizeFacilityName,
  normalizeZip,
  findFacilityByNameMatch,
} = require("../utils/facilityNameUtils");

class Facility {
  static async findAll(filters = {}, connection = null) {
    const pool = connection || getPool();
    const conditions = ["is_active = 1"];
    const params = {};

    if (filters.search) {
      conditions.push("facility_name LIKE :searchPrefix");
      params.searchPrefix = `${Facility.escapeLikePrefix(filters.search)}%`;
    }

    const limit =
      filters.limit && Number(filters.limit) > 0
        ? Math.min(Number(filters.limit), 500)
        : null;
    const offset =
      filters.offset && Number(filters.offset) >= 0
        ? Number(filters.offset)
        : null;
    const limitClause = limit
      ? offset !== null
        ? `LIMIT ${offset}, ${limit}`
        : `LIMIT ${limit}`
      : "";

    const [rows] = await pool.execute(
      `SELECT id, facility_name, city, zip_code, state, email, phone, is_active, is_auto_created
       FROM facilities
       WHERE ${conditions.join(" AND ")}
       ORDER BY id DESC
       ${limitClause}`,
      params
    );

    return rows;
  }

  static async findAllKeyset(filters = {}, connection = null) {
    const pool = connection || getPool();
    const conditions = ["is_active = 1"];
    const params = {};
    const sortDir =
      String(filters.sortDir || "").toLowerCase() === "asc" ? "asc" : "desc";

    if (filters.search) {
      conditions.push("facility_name LIKE :searchPrefix");
      params.searchPrefix = `${Facility.escapeLikePrefix(filters.search)}%`;
    }

    const cursorId =
      Number(filters.cursorId) > 0 ? Number(filters.cursorId) : null;
    if (cursorId) {
      conditions.push(sortDir === "asc" ? "id > :cursorId" : "id < :cursorId");
      params.cursorId = cursorId;
    }

    const pageSize = Math.min(Math.max(Number(filters.pageSize) || 10, 1), 100);
    const queryLimit = pageSize + 1;
    const orderDirection = sortDir === "asc" ? "ASC" : "DESC";

    const [rows] = await pool.execute(
      `SELECT id, facility_name, city, zip_code, state, email, phone, is_active, is_auto_created
       FROM facilities
       WHERE ${conditions.join(" AND ")}
       ORDER BY id ${orderDirection}
       LIMIT ${queryLimit}`,
      params
    );

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const nextCursor = hasMore ? pageRows[pageRows.length - 1]?.id || null : null;

    return {
      rows: pageRows,
      pageSize,
      hasMore,
      nextCursor,
    };
  }

  static async findById(id, connection = null) {
    const db = connection || getPool();

    const [rows] = await db.execute(
      `SELECT *
       FROM facilities
       WHERE id = :id AND is_active = 1
       LIMIT 1`,
      { id }
    );

    return rows[0] || null;
  }

  static async findByFacilityName(facilityName, connection = null) {
    const db = connection || getPool();
    const trimmed = `${facilityName || ""}`.trim();

    if (!trimmed) return null;

    const [rows] = await db.execute(
      `SELECT *
       FROM facilities
       WHERE is_active = 1
         AND LOWER(TRIM(facility_name)) = LOWER(TRIM(:facilityName))
       LIMIT 1`,
      { facilityName: trimmed }
    );

    return rows[0] || null;
  }

  static async findByNormalizedName(normalizedName, connection = null) {
    const db = connection || getPool();
    const normalized = normalizeFacilityName(normalizedName);

    if (!normalized) return null;

    try {
      const [rows] = await db.execute(
        `SELECT *
         FROM facilities
         WHERE is_active = 1
           AND name_normalized = :normalized
         LIMIT 1`,
        { normalized }
      );

      return rows[0] || null;
    } catch (error) {
      if (error.code === "ER_BAD_FIELD_ERROR") {
        return null;
      }

      rethrowServiceError(error);
    }
  }

  static async findByZipCode(zipCode, connection = null) {
    const db = connection || getPool();
    const zip = normalizeZip(zipCode);

    if (!zip) return [];

    const [rows] = await db.execute(
      `SELECT *
       FROM facilities
       WHERE is_active = 1
         AND REPLACE(zip_code, ' ', '') LIKE :zipPrefix
       ORDER BY id DESC`,
      { zipPrefix: `${zip}%` }
    );

    return rows;
  }

  static async findBySlug(slug, connection = null) {
    const db = connection || getPool();
    const trimmed = `${slug || ""}`.trim();
    if (!trimmed) return null;

    const [rows] = await db.execute(
      `SELECT *
       FROM facilities
       WHERE slug = :slug
       ORDER BY is_active DESC, id DESC
       LIMIT 1`,
      { slug: trimmed }
    );

    return rows[0] || null;
  }

  static async findBestMatch(
    { facilityName, city = "", state = "", zipCode = "", zip: zipInput = "" } = {},
    connection = null
  ) {
    const trimmedName = `${facilityName || ""}`.trim();

    if (!trimmedName) return null;

    const exact = await this.findByFacilityName(trimmedName, connection);
    if (exact) return exact;

    const normalizedMatch = await this.findByNormalizedName(
      trimmedName,
      connection
    );
    if (normalizedMatch) return normalizedMatch;

    const zip = normalizeZip(zipCode || zipInput);
    if (zip) {
      const candidates = await this.findByZipCode(zip, connection);
      const zipMatch = findFacilityByNameMatch(trimmedName, candidates);
      if (zipMatch) return zipMatch;
    }

    return null;
  }

  static async search(query, limit = 10) {
    const pool = getPool();
    const trimmed = `${query || ""}`.trim();

    if (!trimmed) return [];

    const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 25);

    const [rows] = await pool.execute(
      `SELECT id, facility_name, address, city, zip_code, state, email, phone, is_active, is_auto_created
       FROM facilities
       WHERE is_active = 1
         AND facility_name LIKE :queryPrefix
       ORDER BY facility_name ASC
       LIMIT ${safeLimit}`,
      { queryPrefix: `${Facility.escapeLikePrefix(trimmed)}%` }
    );

    return rows;
  }

  /**
   * Public portal search: match facility name and/or street address
   * (and city/state/zip) so users can look up by either field.
   */
  static async searchByNameOrAddress(query, limit = 10) {
    const pool = getPool();
    const trimmed = `${query || ""}`.trim();

    if (!trimmed) return [];

    const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 25);
    const escaped = Facility.escapeLikePrefix(trimmed);
    const queryPrefix = `${escaped}%`;
    const queryContains = `%${escaped}%`;

    const [rows] = await pool.execute(
      `SELECT id, facility_name, address, city, zip_code, state, email, phone, is_active, is_auto_created
       FROM facilities
       WHERE is_active = 1
         AND (
           facility_name LIKE :queryContains
           OR IFNULL(address, '') LIKE :queryContains
           OR IFNULL(city, '') LIKE :queryContains
           OR IFNULL(zip_code, '') LIKE :queryContains
           OR CONCAT_WS(
                ', ',
                NULLIF(TRIM(IFNULL(address, '')), ''),
                NULLIF(TRIM(IFNULL(city, '')), ''),
                NULLIF(
                  TRIM(CONCAT_WS(' ', NULLIF(TRIM(IFNULL(state, '')), ''), NULLIF(TRIM(IFNULL(zip_code, '')), ''))),
                  ''
                )
              ) LIKE :queryContains
         )
       ORDER BY
         CASE
           WHEN facility_name LIKE :queryPrefix THEN 0
           WHEN IFNULL(address, '') LIKE :queryPrefix THEN 1
           ELSE 2
         END,
         facility_name ASC
       LIMIT ${safeLimit}`,
      { queryPrefix, queryContains }
    );

    return rows;
  }

  /**
   * Username uniqueness check — includes inactive rows so soft-deleted
   * facilities do not poison auto-create (uq_facilities_user_name).
   */
  static async findByUserName(userName, excludeId = null) {
    const pool = getPool();

    const [rows] = await pool.execute(
      `SELECT id, is_active FROM facilities
       WHERE user_name = :userName
         ${excludeId ? "AND id <> :excludeId" : ""}
       LIMIT 1`,
      { userName, excludeId }
    );

    return rows[0] || null;
  }

  /** Match inactive facility by case-insensitive name (for revive on auto-create). */
  static async findInactiveByFacilityName(facilityName, connection = null) {
    const db = connection || getPool();
    const trimmed = `${facilityName || ""}`.trim();
    if (!trimmed) return null;

    const [rows] = await db.execute(
      `SELECT *
       FROM facilities
       WHERE is_active = 0
         AND LOWER(TRIM(facility_name)) = LOWER(TRIM(:facilityName))
       ORDER BY id DESC
       LIMIT 1`,
      { facilityName: trimmed }
    );

    return rows[0] || null;
  }

  static async reactivate(id, connection = null) {
    const db = connection || getPool();
    await db.execute(
      `UPDATE facilities SET is_active = 1, updated_at = NOW() WHERE id = :id`,
      { id }
    );
  }

  static async create(connection, data) {
    const basePayload = { ...data };
    delete basePayload.nameNormalized;

    try {
      const [result] = await connection.execute(
        `INSERT INTO facilities (
          facility_name, name_normalized, slug, user_name, password_hash,
          contact_first_name, contact_middle_name, contact_last_name,
          address, zip_code, city, state, phone, fax, email, ip_addresses,
          is_active, is_auto_created, created_at, updated_at
        ) VALUES (
          :facilityName, :nameNormalized, :slug, :userName, :passwordHash,
          :contactFirstName, :contactMiddleName, :contactLastName,
          :address, :zipCode, :city, :state, :phone, :fax, :email, :ipAddresses,
          1, :isAutoCreated, NOW(), NOW()
        )`,
        data
      );

      return result.insertId;
    } catch (error) {
      if (error.code !== "ER_BAD_FIELD_ERROR") {
        rethrowServiceError(error);
      }

      const [result] = await connection.execute(
        `INSERT INTO facilities (
          facility_name, slug, user_name, password_hash,
          contact_first_name, contact_middle_name, contact_last_name,
          address, zip_code, city, state, phone, fax, email, ip_addresses,
          is_active, is_auto_created, created_at, updated_at
        ) VALUES (
          :facilityName, :slug, :userName, :passwordHash,
          :contactFirstName, :contactMiddleName, :contactLastName,
          :address, :zipCode, :city, :state, :phone, :fax, :email, :ipAddresses,
          1, :isAutoCreated, NOW(), NOW()
        )`,
        basePayload
      );

      return result.insertId;
    }
  }

  static async update(id, data) {
    const pool = getPool();
    const payload = { ...data, id };

    try {
      await pool.execute(
        `UPDATE facilities SET
          facility_name = :facilityName,
          name_normalized = :nameNormalized,
          slug = :slug,
          contact_first_name = :contactFirstName,
          contact_middle_name = :contactMiddleName,
          contact_last_name = :contactLastName,
          address = :address,
          zip_code = :zipCode,
          city = :city,
          state = :state,
          phone = :phone,
          fax = :fax,
          email = :email,
          ip_addresses = :ipAddresses,
          is_auto_created = :isAutoCreated,
          updated_at = NOW()
         WHERE id = :id AND is_active = 1`,
        payload
      );
    } catch (error) {
      if (error.code !== "ER_BAD_FIELD_ERROR") {
        rethrowServiceError(error);
      }

      const legacyPayload = { ...payload };
      delete legacyPayload.nameNormalized;

      await pool.execute(
        `UPDATE facilities SET
          facility_name = :facilityName,
          slug = :slug,
          contact_first_name = :contactFirstName,
          contact_middle_name = :contactMiddleName,
          contact_last_name = :contactLastName,
          address = :address,
          zip_code = :zipCode,
          city = :city,
          state = :state,
          phone = :phone,
          fax = :fax,
          email = :email,
          ip_addresses = :ipAddresses,
          is_auto_created = :isAutoCreated,
          updated_at = NOW()
         WHERE id = :id AND is_active = 1`,
        legacyPayload
      );
    }
  }

  static async lockRowById(connection, id) {
    const db = connection || getPool();
    const [rows] = await db.execute(
      `SELECT *
       FROM facilities
       WHERE id = :id
       LIMIT 1
       FOR UPDATE`,
      { id }
    );
    return rows[0] || null;
  }

  static async deactivate(id, connection = null) {
    const db = connection || getPool();

    await db.execute(
      `UPDATE facilities
       SET is_active = 0, updated_at = NOW()
       WHERE id = :id
         AND is_active = 1`,
      { id }
    );
  }

  static escapeLikePrefix(value) {
    return `${value || ""}`.replace(/[\\%_]/g, (character) => `\\${character}`);
  }
}

module.exports = Facility;
