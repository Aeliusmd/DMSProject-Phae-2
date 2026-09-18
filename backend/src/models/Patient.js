/**
 * Patient model — stable applicant identity + order number sequences.
 * Order numbers are formatted as LPAD(patient_number,4,'0')-sequence (e.g. 0001-1).
 */

const { getPool } = require("../config/database");
const { toSqlDateOnly } = require("../utils/dateUtils");

function digitsOnly(value) {
  return `${value || ""}`.replace(/\D/g, "");
}

function normalizeName(value) {
  return `${value || ""}`.trim().toLowerCase();
}

function formatPatientOrderNumber(patientNumber, sequence) {
  const padded = String(Number(patientNumber)).padStart(4, "0");
  return `${padded}-${Number(sequence)}`;
}

class Patient {
  static formatOrderNumber(patientNumber, sequence) {
    return formatPatientOrderNumber(patientNumber, sequence);
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
   * Find or create patient, then allocate the next order sequence.
   * Returns { patientId, patientNumber, patientOrderSequence, orderNumber }.
   */
  static async allocateOrderNumber(connection, identity = {}) {
    let patient = await this.findMatch(connection, identity);

    if (!patient) {
      patient = await this.create(connection, identity);
    }

    const patientOrderSequence = await this.allocateOrderSequence(
      connection,
      patient.id
    );
    const patientNumber = Number(patient.patient_number);

    return {
      patientId: patient.id,
      patientNumber,
      patientOrderSequence,
      orderNumber: formatPatientOrderNumber(patientNumber, patientOrderSequence),
    };
  }
}

module.exports = Patient;
