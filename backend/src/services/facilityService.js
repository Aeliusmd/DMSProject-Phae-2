const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const ApiError = require("../utils/ApiError");
const { rethrowServiceError } = require("../utils/serviceErrorUtils");
const { slugify } = require("../utils/slugify");
const {
  normalizeFacilityName,
} = require("../utils/facilityNameUtils");
const {
  findDoctorByNameMatch,
  parseDoctorName,
} = require("../utils/doctorNameUtils");
const {
  validateFacilityPayload,
  validateDoctorsPayload,
} = require("../lib/facilityValidation");
const Facility = require("../models/Facility");
const OfficeManager = require("../models/OfficeManager");
const FacilityDoctor = require("../models/FacilityDoctor");
const { getPool } = require("../config/database");
const { sanitizeSearchText, sanitizeText } = require("../utils/sanitize");
const { sanitizeZip, sanitizeZipOrNull } = require("../utils/zipUtils");

function formatDoctorName(doctor) {
  return [doctor.first_name, doctor.middle_name, doctor.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function mapManagerRow(row) {
  return {
    id: row.id,
    firstName: row.first_name || "",
    middleName: row.middle_name || "",
    lastName: row.last_name || "",
    phone: row.phone || "",
    email: row.email || "",
  };
}

function mapDoctorRow(row) {
  return {
    id: row.id,
    office: row.office_name || "",
    doctor: formatDoctorName(row),
    officeName: row.office_name || "",
    firstName: row.first_name || "",
    middleName: row.middle_name || "",
    lastName: row.last_name || "",
    phone: row.phone || "",
    fax: row.fax || "",
    email: row.email || "",
    defaultDoctor: Boolean(row.is_default),
    active: Boolean(row.is_active),
  };
}

const PLACEHOLDER_FACILITY_EMAIL_SUFFIX = "@facility.pending";

function isPlaceholderFacilityEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase()
    .endsWith(PLACEHOLDER_FACILITY_EMAIL_SUFFIX);
}

function sanitizeFacilityEmail(email) {
  if (isPlaceholderFacilityEmail(email)) return "";
  return `${email || ""}`.trim();
}

function resolveFacilityEmailForStorage(data = {}) {
  if (data.isAutoCreated) {
    return "";
  }

  if (data.email === "" || data.email == null) {
    return "";
  }

  const trimmed = `${data.email}`.trim();
  if (!trimmed) {
    return "";
  }

  if (isPlaceholderFacilityEmail(trimmed)) {
    return "";
  }

  return trimmed;
}

function isFacilityProfileIncomplete(row = {}) {
  if (!row) return true;
  // Only facility name is required (batch-scan auto-create and manual create).
  // Email and other contact fields are optional.
  const name = `${row.facility_name || row.facilityName || row.facility || ""}`.trim();
  return !name;
}

function mapFacilityRow(row) {
  return {
    id: row.id,
    facility: row.facility_name,
    facilityName: row.facility_name,
    address: row.address || "",
    city: row.city || "",
    zip: sanitizeZip(row.zip_code || ""),
    state: row.state || "",
    email: sanitizeFacilityEmail(row.email),
    isAutoCreated: Boolean(Number(row.is_auto_created)),
    isProfileIncomplete: isFacilityProfileIncomplete(row),
  };
}

function formatFacilityAddress(row = {}) {
  const street = `${row.address || ""}`.trim();
  const city = `${row.city || ""}`.trim();
  const state = `${row.state || ""}`.trim();
  const zip = sanitizeZip(row.zip_code || row.zip || "");
  const cityStateZip = [city, [state, zip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");

  return [street, cityStateZip].filter(Boolean).join(", ");
}

function mapPublicFacilitySearchRow(row) {
  return {
    id: row.id,
    facilityName: row.facility_name || row.facilityName || "",
    address: formatFacilityAddress(row),
    streetAddress: row.address || "",
    city: row.city || "",
    state: row.state || "",
    zip: sanitizeZip(row.zip_code || ""),
  };
}

async function searchFacilities(query) {
  const rows = await Facility.search(sanitizeSearchText(query));
  return rows.map(mapFacilityRow);
}

async function searchFacilitiesForPublic(query) {
  const rows = await Facility.searchByNameOrAddress(sanitizeSearchText(query));
  return rows.map(mapPublicFacilitySearchRow);
}

function mapFacilityListRow(row) {
  return {
    id: row.id,
    facility: row.facility_name,
    city: row.city || "",
    zip: sanitizeZip(row.zip_code || ""),
    isAutoCreated: Boolean(Number(row.is_auto_created)),
    isProfileIncomplete: isFacilityProfileIncomplete(row),
  };
}

function mapFacilityDetail(row, managers = [], doctors = []) {
  return {
    id: row.id,
    facilityName: row.facility_name,
    firstName: row.contact_first_name || "",
    middleName: row.contact_middle_name || "",
    lastName: row.contact_last_name || "",
    address: row.address || "",
    zip: sanitizeZip(row.zip_code || ""),
    zipCode: sanitizeZip(row.zip_code || ""),
    city: row.city || "",
    state: row.state || "",
    phone: row.phone || "",
    fax: row.fax || "",
    email: sanitizeFacilityEmail(row.email),
    ipAddresses: row.ip_addresses || "",
    isAutoCreated: Boolean(Number(row.is_auto_created)),
    isProfileIncomplete: isFacilityProfileIncomplete(row),
    officeManagers: managers.map(mapManagerRow),
    doctors: doctors.map(mapDoctorRow),
  };
}

async function acquireFacilityCreateLock(connection, facilityName) {
  if (!connection) return null;

  const lockKey = `facility-create:${normalizeFacilityName(facilityName)}`.slice(
    0,
    64
  );

  const [rows] = await connection.execute(
    `SELECT GET_LOCK(:lockKey, 10) AS acquired`,
    { lockKey }
  );

  if (!Number(rows[0]?.acquired)) {
    throw new ApiError(409, "Facility lookup is busy, please retry");
  }

  return lockKey;
}

async function releaseFacilityCreateLock(connection, lockKey) {
  if (!connection || !lockKey) return;

  await connection.execute(`SELECT RELEASE_LOCK(:lockKey)`, { lockKey });
}

function isFacilitySlugConflict(error) {
  const raw = error?.cause || error;
  if (raw?.code !== "ER_DUP_ENTRY") return false;
  return /uq_facilities_slug/i.test(`${raw.message || raw.sqlMessage || ""}`);
}

async function reuseExistingFacility(row, connection = null) {
  if (!row?.id) return null;

  if (Number(row.is_active) === 0) {
    await Facility.reactivate(row.id, connection);
    const revived = await Facility.findById(row.id, connection);
    if (revived) {
      return {
        facility: mapFacilityRow(revived),
        created: false,
        reactivated: true,
      };
    }
  }

  return {
    facility: mapFacilityRow(row),
    created: false,
    reactivated: false,
  };
}

async function findOrCreateFacility(data, connection = null) {
  const facilityName = sanitizeText(data.facilityName, {
    maxLength: 200,
    allowEmpty: true,
  });

  if (!facilityName) {
    throw new ApiError(400, "Facility name is required");
  }

  const lockKey = await acquireFacilityCreateLock(connection, facilityName);

  try {
    const existing = await Facility.findBestMatch(
      {
        facilityName,
        address: data.address || "",
        city: data.city || "",
        state: data.state || "",
        zipCode: sanitizeZip(data.zipCode || data.zip || ""),
      },
      connection
    );

    if (existing) {
      return {
        facility: mapFacilityRow(existing),
        created: false,
        reactivated: false,
      };
    }

    // Soft-deleted facility with the same name — revive instead of colliding
    // on uq_facilities_user_name when generating a new username.
    const inactive = await Facility.findInactiveByFacilityName(
      facilityName,
      connection
    );
    if (inactive?.id) {
      await Facility.reactivate(inactive.id, connection);
      const revived = await Facility.findById(inactive.id, connection);
      if (revived) {
        return {
          facility: mapFacilityRow(revived),
          created: false,
          reactivated: true,
        };
      }
    }

    const existingBySlug = await Facility.findBySlug(
      slugify(facilityName),
      connection
    );
    const reusedBySlug = await reuseExistingFacility(existingBySlug, connection);
    if (reusedBySlug) {
      return reusedBySlug;
    }

    const userName = await generateUniqueFacilityUserName(facilityName);
    const passwordHash = await generateInternalPasswordHash();
    const facilityPayload = buildFacilityDbPayload(
      {
        facilityName,
        email: "",
        address: data.address || "",
        city: data.city || "",
        state: data.state || "",
        zipCode: sanitizeZip(data.zipCode || data.zip || ""),
        isAutoCreated: true,
      },
      { userName, passwordHash }
    );

    const db = connection || getPool();
    try {
      const facilityId = await Facility.create(db, facilityPayload);
      const created = await Facility.findById(facilityId, connection);

      return {
        facility: mapFacilityRow(created),
        created: true,
        reactivated: false,
      };
    } catch (error) {
      if (isFacilitySlugConflict(error)) {
        const bySlug = await Facility.findBySlug(
          facilityPayload.slug,
          connection
        );
        const recovered = await reuseExistingFacility(bySlug, connection);
        if (recovered) return recovered;
      }

      rethrowServiceError(error);
    }
  } finally {
    await releaseFacilityCreateLock(connection, lockKey);
  }
}

async function resolveFacilityFromHints(
  hints = {},
  connection = null,
  { allowCreate = false } = {}
) {
  const {
    parseUsAddress,
    splitNameAndAddress,
  } = require("../utils/addressParseUtils");

  const fromCustomer = splitNameAndAddress(
    hints.customer || hints.facilityName || ""
  );
  const facilityName = `${fromCustomer.name || hints.customer || hints.facilityName || ""}`.trim();

  if (!facilityName) {
    return { facility: null, created: false, reactivated: false };
  }

  const addressSource =
    fromCustomer.address ||
    hints.facilityAddress ||
    hints.doctorAddress ||
    hints.address ||
    "";
  const parsed = parseUsAddress(addressSource);
  const matchPayload = {
    facilityName,
    address:
      hints.facilityAddress ||
      parsed.address ||
      addressSource ||
      hints.address ||
      "",
    city: hints.facilityCity || parsed.city || hints.city || "",
    state: hints.facilityState || parsed.state || hints.state || "",
    zipCode: sanitizeZip(
      hints.facilityZip ||
        parsed.zip ||
        hints.zip ||
        hints.zipCode ||
        ""
    ),
  };

  if (!allowCreate) {
    const existing = await Facility.findBestMatch(matchPayload, connection);
    return {
      facility: existing ? mapFacilityRow(existing) : null,
      created: false,
      reactivated: false,
    };
  }

  const { facility, created, reactivated } = await findOrCreateFacility(
    matchPayload,
    connection
  );

  return { facility, created, reactivated: Boolean(reactivated) };
}

async function resolveFacilityByName(data = {}) {
  const { facility, created, reactivated } = await findOrCreateFacility(data);
  return { facility, created, reactivated: Boolean(reactivated) };
}

function buildFacilityDbPayload(data, credentials = null) {
  const facilityName = sanitizeText(data.facilityName, {
    maxLength: 200,
    allowEmpty: true,
  });
  const payload = {
    facilityName,
    nameNormalized: normalizeFacilityName(facilityName),
    slug: slugify(facilityName),
    contactFirstName: sanitizeText(data.firstName, { maxLength: 100, allowEmpty: true }) || null,
    contactMiddleName: sanitizeText(data.middleName, { maxLength: 100, allowEmpty: true }) || null,
    contactLastName: sanitizeText(data.lastName, { maxLength: 100, allowEmpty: true }) || null,
    address: sanitizeText(data.address, { maxLength: 255, allowEmpty: true }) || null,
    zipCode: sanitizeZipOrNull(data.zipCode || data.zip),
    city: sanitizeText(data.city, { maxLength: 100, allowEmpty: true }) || null,
    state: sanitizeText(data.state, { maxLength: 2, allowEmpty: true }) || null,
    phone: sanitizeText(data.phone, { maxLength: 20, allowEmpty: true }) || null,
    fax: sanitizeText(data.fax, { maxLength: 20, allowEmpty: true }) || null,
    email: resolveFacilityEmailForStorage(data),
    ipAddresses: data.ipAddresses?.trim() || null,
    isAutoCreated:
      data.isAutoCreated !== undefined ? (data.isAutoCreated ? 1 : 0) : 0,
  };

  if (credentials?.userName) {
    payload.userName = credentials.userName;
  }

  if (credentials?.passwordHash) {
    payload.passwordHash = credentials.passwordHash;
  }

  return payload;
}

async function generateUniqueFacilityUserName(facilityName) {
  const base = slugify(facilityName).slice(0, 50) || "facility";
  let candidate = base;
  let suffix = 0;

  while (await Facility.findByUserName(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`.slice(0, 100);
  }

  return candidate;
}

async function generateInternalPasswordHash() {
  return bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
}

function normalizeManagers(managers = []) {
  return managers
    .map((manager) => ({
      id: manager.id || null,
      firstName: manager.firstName?.trim() || "",
      middleName: manager.middleName?.trim() || "",
      lastName: manager.lastName?.trim() || "",
      phone: manager.phone?.trim() || "",
      email: manager.email?.trim() || "",
    }))
    .filter(
      (manager) =>
        manager.firstName ||
        manager.middleName ||
        manager.lastName ||
        manager.phone ||
        manager.email
    );
}

async function syncManagers(facilityId, managers, actorId) {
  const keepIds = [];

  for (const manager of managers) {
    if (manager.id) {
      await OfficeManager.update(manager.id, manager);
      keepIds.push(manager.id);
    } else {
      const pool = getPool();
      const connection = await pool.getConnection();

      try {
        const newId = await OfficeManager.create(connection, {
          facilityId,
          ...manager,
        });
        keepIds.push(newId);
      } finally {
        connection.release();
      }
    }
  }

  await OfficeManager.softDeleteMissing(facilityId, keepIds, actorId);
}

async function getAllFacilities(query = {}) {
  const filters = {};

  if (query.search && `${query.search}`.trim()) {
    filters.search = sanitizeSearchText(query.search);
  }

  if (query.limit) {
    const limit = Number(query.limit);
    if (Number.isFinite(limit) && limit > 0) {
      filters.limit = limit;
    }
  }

  const sortDir =
    String(query.sortDir || "").toLowerCase() === "asc" ? "asc" : "desc";
  filters.sortDir = sortDir;

  const useKeysetPagination =
    String(query.pagination || "").toLowerCase() === "keyset";
  const pageSizeRaw = Number(query.pageSize || filters.limit || 10);
  const pageSize = Number.isFinite(pageSizeRaw)
    ? Math.min(Math.max(pageSizeRaw, 1), 100)
    : 10;
  const cursorRaw = Number(query.cursor);
  const cursorId = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : null;

  if (!useKeysetPagination) {
    const facilities = await Facility.findAll(filters);
    return facilities.map(mapFacilityListRow);
  }

  const keysetResult = await Facility.findAllKeyset({
    ...filters,
    pageSize,
    cursorId,
  });

  return {
    facilities: keysetResult.rows.map(mapFacilityListRow),
    pagination: {
      type: "keyset",
      pageSize: keysetResult.pageSize,
      hasMore: keysetResult.hasMore,
      nextCursor: keysetResult.nextCursor,
    },
  };
}

async function getFacilityById(id) {
  const facility = await Facility.findById(id);

  if (!facility) {
    throw new ApiError(404, "Facility not found");
  }

  const managers = await OfficeManager.findByFacilityId(id);
  const doctors = await FacilityDoctor.findByFacilityId(id);

  return mapFacilityDetail(facility, managers, doctors);
}

async function createFacility(data) {
  const validation = validateFacilityPayload(data);

  if (!validation.valid) {
    throw new ApiError(400, "Validation failed", validation.errors);
  }

  const userName = await generateUniqueFacilityUserName(data.facilityName);
  const passwordHash = await generateInternalPasswordHash();
  const facilityPayload = buildFacilityDbPayload(data, { userName, passwordHash });
  const managers = normalizeManagers(data.officeManagers || data.managers || []);

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const facilityId = await Facility.create(connection, facilityPayload);

    for (const manager of managers) {
      await OfficeManager.create(connection, {
        facilityId,
        ...manager,
      });
    }

    await connection.commit();

    return getFacilityById(facilityId);
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }
}

async function updateFacility(id, data, actorId) {
  const facility = await Facility.findById(id);

  if (!facility) {
    throw new ApiError(404, "Facility not found");
  }

  const validation = validateFacilityPayload(data);

  if (!validation.valid) {
    throw new ApiError(400, "Validation failed", validation.errors);
  }

  const facilityPayload = buildFacilityDbPayload(data);
  // Any staff save completes an auto-created / incomplete profile. Email optional.
  facilityPayload.isAutoCreated = 0;

  await Facility.update(id, facilityPayload);

  const managers = normalizeManagers(data.officeManagers || []);
  await syncManagers(id, managers, actorId);

  return getFacilityById(id);
}

async function deleteFacility(id) {
  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const facility = await Facility.lockRowById(connection, id);

    if (!facility) {
      throw new ApiError(404, "Facility not found");
    }

    if (!Number(facility.is_active)) {
      throw new ApiError(409, "This facility is already deleted");
    }

    await Facility.deactivate(id, connection);
    await connection.commit();

    return {
      deleted: true,
      message: "Facility deleted successfully",
      id: facility.id,
      facilityName: facility.facility_name || "",
    };
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }
}

async function createDoctors(facilityId, doctorsInput = []) {
  const facility = await Facility.findById(facilityId);

  if (!facility) {
    throw new ApiError(404, "Facility not found");
  }

  const doctors = doctorsInput
    .map((doctor) => ({
      officeName: doctor.officeName?.trim() || "",
      firstName: doctor.firstName?.trim() || "",
      middleName: doctor.middleName?.trim() || "",
      lastName: doctor.lastName?.trim() || "",
      phone: doctor.phone?.trim() || "",
      fax: doctor.fax?.trim() || "",
      email: doctor.email?.trim() || "",
      isDefault: Boolean(doctor.isDefault),
    }))
    .filter(
      (doctor) =>
        doctor.officeName ||
        doctor.firstName ||
        doctor.lastName ||
        doctor.phone ||
        doctor.fax ||
        doctor.email
    );

  if (doctors.length === 0) {
    throw new ApiError(400, "At least one doctor is required");
  }

  const validation = validateDoctorsPayload(doctors);

  if (!validation.valid) {
    throw new ApiError(400, "Validation failed", validation.errors);
  }

  const existingDoctors = await FacilityDoctor.findByFacilityId(facilityId, {
    activeOnly: true,
  });

  const hasExistingDefault = existingDoctors.some((doctor) => doctor.is_default);
  const requestedDefaultCount = doctors.filter((doctor) => doctor.isDefault).length;

  if (requestedDefaultCount > 1) {
    throw new ApiError(400, "Only one doctor can be set as default");
  }

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    let shouldAssignDefault = !hasExistingDefault;

    for (const doctor of doctors) {
      const makeDefault =
        doctor.isDefault || (shouldAssignDefault && requestedDefaultCount === 0);

      if (makeDefault) {
        await FacilityDoctor.clearDefaultForFacility(facilityId, connection);
        shouldAssignDefault = false;
      }

      await FacilityDoctor.create(connection, {
        facilityId,
        officeName: doctor.officeName,
        firstName: doctor.firstName,
        middleName: doctor.middleName,
        lastName: doctor.lastName,
        phone: doctor.phone,
        fax: doctor.fax,
        email: doctor.email,
        isDefault: makeDefault ? 1 : 0,
      });
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }

  const doctorsList = await FacilityDoctor.findByFacilityId(facilityId);
  return doctorsList.map(mapDoctorRow);
}

async function deactivateDoctor(facilityId, doctorId) {
  const doctor = await FacilityDoctor.findById(doctorId, facilityId);

  if (!doctor) {
    throw new ApiError(404, "Doctor not found");
  }

  if (!doctor.is_active) {
    throw new ApiError(400, "Doctor is already inactive");
  }

  await FacilityDoctor.setActiveStatus(doctorId, facilityId, false);

  if (doctor.is_default) {
    await FacilityDoctor.clearDefaultForFacility(facilityId);
    const nextDoctor = await FacilityDoctor.getNextDefaultCandidate(
      facilityId,
      doctorId
    );

    if (nextDoctor) {
      await FacilityDoctor.setDefault(nextDoctor.id, facilityId);
    }
  }

  const updated = await FacilityDoctor.findById(doctorId, facilityId);
  return mapDoctorRow(updated);
}

async function reactivateDoctor(facilityId, doctorId) {
  const doctor = await FacilityDoctor.findById(doctorId, facilityId);

  if (!doctor) {
    throw new ApiError(404, "Doctor not found");
  }

  if (doctor.is_active) {
    throw new ApiError(400, "Doctor is already active");
  }

  await FacilityDoctor.setActiveStatus(doctorId, facilityId, true);

  const activeDoctors = await FacilityDoctor.findByFacilityId(facilityId, {
    activeOnly: true,
  });

  const hasDefault = activeDoctors.some((item) => item.is_default);

  if (!hasDefault) {
    await FacilityDoctor.setDefault(doctorId, facilityId);
  }

  const updated = await FacilityDoctor.findById(doctorId, facilityId);
  return mapDoctorRow(updated);
}

async function setDefaultDoctor(facilityId, doctorId) {
  const doctor = await FacilityDoctor.findById(doctorId, facilityId);

  if (!doctor) {
    throw new ApiError(404, "Doctor not found");
  }

  if (!doctor.is_active) {
    throw new ApiError(400, "Inactive doctors cannot be set as default");
  }

  await FacilityDoctor.setDefault(doctorId, facilityId);

  const updated = await FacilityDoctor.findById(doctorId, facilityId);
  return mapDoctorRow(updated);
}

async function updateDoctor(facilityId, doctorId, doctorInput = {}) {
  const doctor = await FacilityDoctor.findById(doctorId, facilityId);

  if (!doctor) {
    throw new ApiError(404, "Doctor not found");
  }

  const normalized = {
    officeName: doctorInput.officeName?.trim() || "",
    firstName: doctorInput.firstName?.trim() || "",
    middleName: doctorInput.middleName?.trim() || "",
    lastName: doctorInput.lastName?.trim() || "",
    phone: doctorInput.phone?.trim() || "",
    fax: doctorInput.fax?.trim() || "",
    email: doctorInput.email?.trim() || "",
    isDefault: Boolean(doctorInput.isDefault),
  };

  const validation = validateDoctorsPayload([normalized]);

  if (!validation.valid) {
    throw new ApiError(400, "Validation failed", validation.errors);
  }

  if (!doctor.is_active && normalized.isDefault) {
    throw new ApiError(400, "Inactive doctors cannot be set as default");
  }

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const shouldBeDefault = normalized.isDefault && doctor.is_active;

    if (shouldBeDefault) {
      await FacilityDoctor.clearDefaultForFacility(facilityId, connection);
    }

    await FacilityDoctor.update(connection, doctorId, facilityId, {
      ...normalized,
      isDefault: shouldBeDefault,
    });

    if (doctor.is_default && !shouldBeDefault) {
      const nextDoctor = await FacilityDoctor.getNextDefaultCandidate(
        facilityId,
        doctorId
      );

      if (nextDoctor) {
        await FacilityDoctor.setDefault(nextDoctor.id, facilityId);
      }
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }

  const updated = await FacilityDoctor.findById(doctorId, facilityId);
  return mapDoctorRow(updated);
}

async function resolveFacilityDoctor(
  facilityId,
  {
    doctorName,
    doctorId,
    useDefaultWhenMissing = true,
    allowCreate = true,
  } = {}
) {
  const id = Number(facilityId);

  if (!Number.isFinite(id)) {
    throw new ApiError(400, "Facility id is required");
  }

  const facility = await Facility.findById(id);

  if (!facility) {
    throw new ApiError(404, "Facility not found");
  }

  const existingDoctors = await FacilityDoctor.findByFacilityId(id, {
    activeOnly: true,
  });
  const parsedDoctorId = Number(doctorId);

  if (Number.isFinite(parsedDoctorId) && parsedDoctorId > 0) {
    const byId =
      existingDoctors.find((doctor) => Number(doctor.id) === parsedDoctorId) ||
      (await FacilityDoctor.findById(parsedDoctorId, id));

    if (byId && Number(byId.is_active) !== 0) {
      return {
        doctor: mapDoctorRow(byId),
        doctorName: formatDoctorName(byId),
        created: false,
        usedDefault: false,
        missingDefault: false,
        doctorMissing: false,
      };
    }
  }

  const trimmedName = sanitizeText(doctorName, { maxLength: 200, allowEmpty: true });

  if (trimmedName) {
    const match = findDoctorByNameMatch(trimmedName, existingDoctors);

    if (match) {
      return {
        doctor: mapDoctorRow(match),
        doctorName: formatDoctorName(match),
        created: false,
        usedDefault: false,
        missingDefault: false,
        doctorMissing: false,
      };
    }

    if (!allowCreate) {
      return {
        doctor: null,
        doctorName: trimmedName,
        created: false,
        usedDefault: false,
        missingDefault: false,
        doctorMissing: true,
      };
    }

    if (!allowCreate) {
      return {
        doctor: null,
        doctorName: "",
        created: false,
        usedDefault: false,
        missingDefault: true,
      };
    }

    const parsed = parseDoctorName(trimmedName);
    const officeName = facility.facility_name || "Main Office";
    const hasDefault = existingDoctors.some((doctor) => doctor.is_default);
    const makeDefault = !hasDefault && existingDoctors.length === 0;

    const pool = getPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      if (makeDefault) {
        await FacilityDoctor.clearDefaultForFacility(id, connection);
      }

      const newId = await FacilityDoctor.create(connection, {
        facilityId: id,
        officeName,
        firstName: parsed.firstName,
        middleName: parsed.middleName,
        lastName: parsed.lastName,
        phone: "",
        fax: "",
        email: "",
        isDefault: makeDefault ? 1 : 0,
      });

      await connection.commit();

      const created = await FacilityDoctor.findById(newId, id);

      return {
        doctor: mapDoctorRow(created),
        doctorName: formatDoctorName(created),
        created: true,
        usedDefault: false,
        missingDefault: false,
        doctorMissing: false,
      };
    } catch (error) {
      await connection.rollback();
      rethrowServiceError(error);
    } finally {
      connection.release();
    }
  }

  if (!useDefaultWhenMissing) {
    return {
      doctor: null,
      doctorName: "",
      created: false,
      usedDefault: false,
      missingDefault: false,
      doctorMissing: false,
    };
  }

  const defaultDoctor = await FacilityDoctor.findDefaultByFacilityId(id);

  if (!defaultDoctor) {
    return {
      doctor: null,
      doctorName: "",
      created: false,
      usedDefault: false,
      missingDefault: true,
      doctorMissing: false,
    };
  }

  return {
    doctor: mapDoctorRow(defaultDoctor),
    doctorName: formatDoctorName(defaultDoctor),
    created: false,
    usedDefault: true,
    missingDefault: false,
    doctorMissing: false,
  };
}

async function resolveDoctorFromExtractHints(
  facilityId,
  hints = {},
  { allowCreate = false } = {}
) {
  const extractedDoctorName = `${hints.specificDoctor || ""}`.trim();
  const result = await resolveFacilityDoctor(facilityId, {
    doctorName: extractedDoctorName || undefined,
    useDefaultWhenMissing: !extractedDoctorName,
    allowCreate,
  });

  return {
    ...result,
    extractedDoctorName,
  };
}

module.exports = {
  getAllFacilities,
  getFacilityById,
  createFacility,
  updateFacility,
  deleteFacility,
  createDoctors,
  updateDoctor,
  deactivateDoctor,
  reactivateDoctor,
  setDefaultDoctor,
  searchFacilities,
  searchFacilitiesForPublic,
  resolveFacilityByName,
  findOrCreateFacility,
  resolveFacilityFromHints,
  resolveFacilityDoctor,
  resolveDoctorFromExtractHints,
  isFacilityProfileIncomplete,
  isPlaceholderFacilityEmail,
};
