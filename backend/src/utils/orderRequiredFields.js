const VALID_RECORD_TYPES = ["medical", "billing", "employment", "xrays", "other"];

const RECORD_TYPE_FLAG_MAP = {
  medical: "medicalRecords",
  billing: "billingRecords",
  employment: "employmentRecords",
  xrays: "xrays",
  other: "otherRecord",
};

const AUTO_PENDING_ORDER_PREFIX = "AUTO-PENDING-";

function isPendingAutoOrderNumber(value) {
  return `${value || ""}`.trim().startsWith(AUTO_PENDING_ORDER_PREFIX);
}

function hasRecordTypesSelected(data = {}, orderRecords = []) {
  if (orderRecords.length > 0) {
    return true;
  }

  if (data.type && VALID_RECORD_TYPES.includes(data.type)) {
    return true;
  }

  return VALID_RECORD_TYPES.some((type) => Boolean(data[RECORD_TYPE_FLAG_MAP[type]]));
}

function hasInjuryPayload(data = {}) {
  const injuryType = `${data.injuryType || ""}`.trim();

  if (injuryType === "specific") {
    return Boolean(`${data.injuryDate || ""}`.trim());
  }

  if (injuryType === "cumulative") {
    return (
      Boolean(`${data.injuryDateBegin || ""}`.trim()) &&
      Boolean(`${data.injuryDateEnd || ""}`.trim())
    );
  }

  return true;
}

const PERSONAL_PLACEHOLDER_FACILITY_NAME =
  "Personal Portal - Pending Facility";

function hasPersonalFacilityName(data = {}) {
  const name = `${data.facilityName || ""}`.trim();
  if (name === PERSONAL_PLACEHOLDER_FACILITY_NAME) {
    return false;
  }
  return Boolean(name || `${data.facility || ""}`.trim());
}

function hasPersonalSpecificDoctor(data = {}) {
  const name = `${data.specificDoctor || ""}`.trim();
  if (!name) return false;
  if (data.doctorNotInSystem) return false;
  return true;
}

function hasPersonalFacilityAddress(data = {}) {
  return Boolean(
    `${data.facilityAddress || ""}`.trim() || `${data.fullAddress || ""}`.trim()
  );
}

function hasPersonalDatesNeeded(data = {}) {
  return (
    Boolean(`${data.injuryDateBegin || ""}`.trim()) &&
    Boolean(`${data.injuryDateEnd || ""}`.trim())
  );
}

function hasPersonalDocument(data = {}) {
  if (data.hasDriverLicenseDocument || data.hasPersonalDocument) return true;
  if (Array.isArray(data.documents) && data.documents.length > 0) return true;
  if (data.additionalDocumentFile) return true;
  return false;
}

const REQUIRED_FIELD_RULES = [
  {
    key: "orderNumber",
    label: "Order number",
    check: (data) =>
      Boolean(`${data.orderNumber || ""}`.trim()) &&
      !isPendingAutoOrderNumber(data.orderNumber),
  },
  {
    key: "facility",
    label: "Facility",
    check: (data) => Boolean(`${data.facility || ""}`.trim()),
  },
  {
    key: "type",
    label: "Record type",
    check: (data, orderRecords) => hasRecordTypesSelected(data, orderRecords),
  },
  {
    key: "firstName",
    label: "First name",
    check: (data) => Boolean(`${data.firstName || ""}`.trim()),
  },
  {
    key: "lastName",
    label: "Last name",
    check: (data) => Boolean(`${data.lastName || ""}`.trim()),
  },
  {
    key: "serveCompanyName",
    label: "Company name",
    check: (data) => Boolean(`${data.serveCompanyName || ""}`.trim()),
  },
  {
    key: "injury",
    label: "Injury date",
    check: (data) => {
      const injuryType = `${data.injuryType || ""}`.trim();
      if (!injuryType) return true;
      return hasInjuryPayload(data);
    },
  },
];

const PERSONAL_REQUIRED_FIELD_RULES = [
  {
    key: "orderNumber",
    label: "Order number",
    check: (data) => Boolean(`${data.orderNumber || ""}`.trim()),
  },
  {
    key: "firstName",
    label: "First name",
    check: (data) => Boolean(`${data.firstName || ""}`.trim()),
  },
  {
    key: "lastName",
    label: "Last name",
    check: (data) => Boolean(`${data.lastName || ""}`.trim()),
  },
  {
    key: "dob",
    label: "Date of birth",
    check: (data) => Boolean(`${data.dob || ""}`.trim()),
  },
  {
    key: "facilityName",
    label: "Treating facility",
    check: (data) => hasPersonalFacilityName(data),
  },
  {
    key: "specificDoctor",
    label: "Specific doctor",
    check: (data) => hasPersonalSpecificDoctor(data),
  },
  {
    key: "datesNeeded",
    label: "Specific dates needed",
    check: (data) => hasPersonalDatesNeeded(data),
  },
  {
    key: "type",
    label: "Type of records needed",
    check: (data, orderRecords) => hasRecordTypesSelected(data, orderRecords),
  },
  {
    key: "driverLicenseNumber",
    label: "Driver's licence number",
    check: (data) => Boolean(`${data.driverLicenseNumber || ""}`.trim()),
  },
  {
    key: "document",
    label: "Document",
    check: (data) => hasPersonalDocument(data),
  },
];

function isPersonalPortalSource(data = {}) {
  return (
    data.creationSource === "personal_portal" ||
    data.creation_source === "personal_portal"
  );
}

function toDateOnlyForRequired(value) {
  if (!value) return "";
  const raw = `${value}`.trim();
  if (!raw) return "";
  return raw.includes("T") ? raw.slice(0, 10) : raw.slice(0, 10);
}

function buildPersonalPortalRequiredFieldData({
  orderRow = {},
  mappedOrder = {},
  requestOrder = null,
  primaryFacility = null,
  orderRecords = [],
  documents = [],
} = {}) {
  const recordTypes = orderRecords.map((record) => record.record_type);

  return {
    creationSource: "personal_portal",
    orderNumber:
      orderRow.order_number ||
      mappedOrder.orderNumber ||
      mappedOrder.id ||
      "",
    firstName: orderRow.applicant_first_name || mappedOrder.firstName || "",
    lastName: orderRow.applicant_last_name || mappedOrder.lastName || "",
    dob: toDateOnlyForRequired(orderRow.dob || mappedOrder.dob),
    facilityName:
      primaryFacility?.facility_name ||
      mappedOrder.facilityName ||
      orderRow.facility_name ||
      "",
    facility:
      mappedOrder.facility ||
      (orderRow.facility_id ? String(orderRow.facility_id) : ""),
    specificDoctor:
      orderRow.specific_doctor ||
      primaryFacility?.treating_doctor ||
      mappedOrder.specificDoctor ||
      mappedOrder.doctor ||
      mappedOrder.requestedTreatingDoctor ||
      "",
    injuryDateBegin: toDateOnlyForRequired(
      orderRow.injury_date_begin ||
        primaryFacility?.records_date_begin ||
        mappedOrder.injuryDateBegin
    ),
    injuryDateEnd: toDateOnlyForRequired(
      orderRow.injury_date_end ||
        primaryFacility?.records_date_end ||
        mappedOrder.injuryDateEnd
    ),
    medicalRecords:
      recordTypes.includes("medical") || Boolean(mappedOrder.medicalRecords),
    billingRecords:
      recordTypes.includes("billing") || Boolean(mappedOrder.billingRecords),
    employmentRecords:
      recordTypes.includes("employment") ||
      Boolean(mappedOrder.employmentRecords),
    xrays: recordTypes.includes("xrays") || Boolean(mappedOrder.xrays),
    otherRecord:
      recordTypes.includes("other") || Boolean(mappedOrder.otherRecord),
    driverLicenseNumber:
      requestOrder?.driver_license_number ||
      mappedOrder.driverLicenseNumber ||
      "",
    hasDriverLicenseDocument: Boolean(
      requestOrder?.driver_license_storage_path ||
        mappedOrder.hasDriverLicenseDocument
    ),
    documents: documents.length ? documents : mappedOrder.documents || [],
    doctorNotInSystem: Boolean(mappedOrder.doctorNotInSystem),
  };
}

function computeMissingRequiredFields(data = {}, orderRecords = []) {
  const rules = isPersonalPortalSource(data)
    ? PERSONAL_REQUIRED_FIELD_RULES
    : REQUIRED_FIELD_RULES;

  return rules
    .filter((rule) => !rule.check(data, orderRecords))
    .map((rule) => rule.label);
}

function mapOrderRowToRequiredFieldData(row = {}, orderRecords = []) {
  const recordTypes = orderRecords.map((record) => record.record_type);
  const primaryType = recordTypes[0] || "";

  return {
    orderNumber: row.order_number || "",
    facility: row.facility_id ? String(row.facility_id) : "",
    facilityName: row.facility_name || "",
    facilityAddress: row.facility_address || row.full_address || "",
    fullAddress: row.full_address || "",
    type: primaryType,
    medicalRecords: recordTypes.includes("medical"),
    billingRecords: recordTypes.includes("billing"),
    employmentRecords: recordTypes.includes("employment"),
    xrays: recordTypes.includes("xrays"),
    otherRecord: recordTypes.includes("other"),
    firstName: row.applicant_first_name || "",
    lastName: row.applicant_last_name || "",
    dob: row.dob || "",
    serveCompanyName: row.serve_company_name || "",
    email: row.serve_email || row.provider_email || "",
    specificDoctor: row.specific_doctor || "",
    injuryType: row.injury_type || "",
    injuryDate: row.injury_date || "",
    injuryDateBegin: row.injury_date_begin || "",
    injuryDateEnd: row.injury_date_end || "",
    driverLicenseNumber: row.driver_license_number || row.driverLicenseNumber || "",
    creationSource: row.creation_source || row.creationSource || "",
    hasDriverLicenseDocument: Boolean(row.hasDriverLicenseDocument),
    hasPersonalDocument: Boolean(row.hasPersonalDocument),
    documents: row.documents || [],
  };
}

module.exports = {
  AUTO_PENDING_ORDER_PREFIX,
  PERSONAL_PLACEHOLDER_FACILITY_NAME,
  buildPersonalPortalRequiredFieldData,
  computeMissingRequiredFields,
  mapOrderRowToRequiredFieldData,
  hasRecordTypesSelected,
  isPendingAutoOrderNumber,
  isPersonalPortalSource,
};
