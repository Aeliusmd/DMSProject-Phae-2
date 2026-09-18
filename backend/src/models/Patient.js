/**
 * Patient model — stable applicant identity + DMS order numbers.
 *
 * Per-patient prefix: LPAD(patient_number, 4, '0') e.g. 0001
 * Per record type (one order = one type):
 *   medical=1, billing=2, employment=3, xrays=4, other=5
 * Examples: 0001-1 (medical), 0001-2 (billing), 0001-3 (employment)
 *
 * If that type number is already used for the patient, falls back to
 * 0001-{sequence} from next_order_sequence.
 */

const { getPool } = require("../config/database");
const { toSqlDateOnly } = require("../utils/dateUtils");

const RECORD_TYPE_ORDER_CODES = {
  medical: 1,
  billing: 2,
  employment: 3,
  xrays: 4,
  other: 5,
};

const RECORD_TYPE_CODE_ORDER = [
  "medical",
  "billing",
  "employment",
  "xrays",
  "other",
];

function digitsOnly(value) {
  return `${value || ""}`.replace(/\D/g, "");
}

function normalizeName(value) {
  return `${value || ""}`.trim().toLowerCase();
}

function padPatientNumber(patientNumber) {
  return String(Number(patientNumber)).padStart(4, "0");
}

function normalizeRecordTypes(recordTypes = []) {
  const selected = new Set(
    (Array.isArray(recordTypes) ? recordTypes : [])
      .map((type) => `${type || ""}`.trim().toLowerCase())
      .filter((type) =>
        Object.prototype.hasOwnProperty.call(RECORD_TYPE_ORDER_CODES, type)
      )
  );

  return RECORD_TYPE_CODE_ORDER.filter((type) => selected.has(type));
}

function formatPatientOrderNumber(
  patientNumber,
  recordTypes = [],
  sequence = null
) {
  const padded = padPatientNumber(patientNumber);
  const types = normalizeRecordTypes(recordTypes);

  // Prefer a single record-type code (orders are split one-type-per-order).
  if (types.length === 1) {
    return `${padded}-${RECORD_TYPE_ORDER_CODES[types[0]]}`;
  }

  // Legacy multi-type on one row (updates) — keep joined codes.
  if (types.length > 1) {
    const codes = types.map((type) => RECORD_TYPE_ORDER_CODES[type]);
    return `${padded}-${codes.join("-")}`;
  }

  const seq = Number(sequence);
  if (Number.isFinite(seq) && seq >= 1) {
    return `${padded}-${seq}`;
  }

  return padded;
}

class Patient {
  static RECORD_TYPE_ORDER_CODES = RECORD_TYPE_ORDER_CODES;

  static formatOrderNumber(patientNumber, recordTypes = [], sequence = null) {
    return formatPatientOrderNumber(patientNumber, recordTypes, sequence);
  }

  static normalizeRecordTypes(recordTypes = []) {
    return normalizeRecordTypes(recordTypes);
  }

  static async findMatch(
    connection,
    { ssnLastFour = null, dob = null, firstName = null, lastName = null } = {}
  ) {
    const db = connection || getPool();
    const sqlDob = toSqlDateOnly(dob);
    const ssn = `${ssnLastFour || ""}`.trim() || null;
    const ssnDigits = digitsOnly(ssn);
    const first = normalizeName(firstName);
    const last = normalizeName(lastName);

    if (ssn && sqlDob && ssnDigits.length >= 4) {
      const lastFour = ssnDigits.slice(-4);
      const [rows] = await db.execute(
        `SELECT id, patient_number, next_order_sequence,
                first_name, middle_name, last_name, dob, ssn_last_four
         FROM patients
         WHERE dob = :dob
           AND (
             ssn_last_four = :ssn
             OR RIGHT(REPLACE(REPLACE(UPPER(COALESCE(ssn_last_four, '')), '-', ''), 'X', ''), 4) = :lastFour
           )
         ORDER BY id ASC
         LIMIT 1
         FOR UPDATE`,
        { dob: sqlDob, ssn, lastFour }
      );
      if (rows[0]) return rows[0];
    }

    if (first && last && sqlDob) {
      const [rows] = await db.execute(
        `SELECT id, patient_number, next_order_sequence,
                first_name, middle_name, last_name, dob, ssn_last_four
         FROM patients
         WHERE dob = :dob
           AND LOWER(TRIM(first_name)) = :firstName
           AND LOWER(TRIM(last_name)) = :lastName
         ORDER BY id ASC
         LIMIT 1
         FOR UPDATE`,
        { dob: sqlDob, firstName: first, lastName: last }
      );
      if (rows[0]) return rows[0];
    }

    return null;
  }

  static async findById(connection, patientId) {
    const db = connection || getPool();
    const id = Number(patientId);
    if (!Number.isFinite(id) || id < 1) return null;

    const [rows] = await db.execute(
      `SELECT id, patient_number, next_order_sequence,
              first_name, middle_name, last_name, dob, ssn_last_four
       FROM patients
       WHERE id = :id
       LIMIT 1
       FOR UPDATE`,
      { id }
    );
    return rows[0] || null;
  }

  static async allocateNextPatientNumber(connection) {
    const db = connection || getPool();

    await db.execute(
      `UPDATE patient_number_counter
       SET next_patient_number = LAST_INSERT_ID(next_patient_number) + 1
       WHERE id = 1`
    );

    const [rows] = await db.execute(`SELECT LAST_INSERT_ID() AS allocated`);
    const allocated = Number(rows[0]?.allocated);
    if (!Number.isFinite(allocated) || allocated < 1) {
      throw new Error("Failed to allocate patient number");
    }
    return allocated;
  }

  static async create(connection, data) {
    const db = connection || getPool();
    const patientNumber =
      data.patientNumber || (await this.allocateNextPatientNumber(connection));

    const [result] = await db.execute(
      `INSERT INTO patients
        (patient_number, first_name, middle_name, last_name, dob, ssn_last_four,
         next_order_sequence, created_at, updated_at)
       VALUES
        (:patientNumber, :firstName, :middleName, :lastName, :dob, :ssnLastFour,
         1, NOW(), NOW())`,
      {
        patientNumber,
        firstName: data.firstName || null,
        middleName: data.middleName || null,
        lastName: data.lastName || null,
        dob: toSqlDateOnly(data.dob) || null,
        ssnLastFour: data.ssnLastFour || null,
      }
    );

    return {
      id: result.insertId,
      patient_number: patientNumber,
      next_order_sequence: 1,
    };
  }

  static async allocateOrderSequence(connection, patientId) {
    const db = connection || getPool();

    await db.execute(
      `UPDATE patients
       SET next_order_sequence = LAST_INSERT_ID(next_order_sequence) + 1,
           updated_at = NOW()
       WHERE id = :patientId`,
      { patientId }
    );

    const [rows] = await db.execute(`SELECT LAST_INSERT_ID() AS allocated`);
    const allocated = Number(rows[0]?.allocated);
    if (!Number.isFinite(allocated) || allocated < 1) {
      throw new Error("Failed to allocate patient order sequence");
    }
    return allocated;
  }

  /**
   * Find or create patient, allocate sequence, build display order number.
   * Prefer type code (0001-1). If taken, use sequence fallback (0001-6).
   */
  static async allocateOrderNumber(
    connection,
    identity = {},
    recordTypes = [],
    { isOrderNumberTaken = null } = {}
  ) {
    let patient = await this.findMatch(connection, identity);

    if (!patient) {
      patient = await this.create(connection, identity);
    }

    const patientOrderSequence = await this.allocateOrderSequence(
      connection,
      patient.id
    );
    const patientNumber = Number(patient.patient_number);
    const types = normalizeRecordTypes(recordTypes);

    let orderNumber = formatPatientOrderNumber(
      patientNumber,
      types,
      patientOrderSequence
    );

    if (typeof isOrderNumberTaken === "function") {
      const taken = await isOrderNumberTaken(orderNumber);
      if (taken) {
        orderNumber = formatPatientOrderNumber(
          patientNumber,
          [],
          patientOrderSequence
        );
      }
    }

    return {
      patientId: patient.id,
      patientNumber,
      patientOrderSequence,
      orderNumber,
    };
  }
}

module.exports = Patient;
