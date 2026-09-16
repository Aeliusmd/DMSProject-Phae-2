const {
  FIELD_LIMITS,
  trimToString,
  getDigits,
  isBlank,
  isValidEmail,
  isValidIsoDate,
  isFutureDate,
  isValidSSN,
  getSsnValidationError,
  isValidMoney,
  addMaxLengthError,
  addOptionalIsoDateError,
} = require("./validationHelpers");
const {
  addPersonNameFormatError,
  addOrganizationNameFormatError,
  addNoHtmlMarkupError,
  addNoHtmlMarkupErrors,
} = require("../utils/nameValidation");
const {
  isPendingAutoOrderNumber,
} = require("../utils/orderRequiredFields");
const {
  ZIP_MAX_CHARS,
  ZIP_VALIDATION_MESSAGE,
  isValidZip,
} = require("../utils/zipUtils");

const ORDER_FREE_TEXT_FIELDS = [
  "address",
  "city",
  "specificRecord",
  "court",
  "caseNumber",
  "recNumber",
  "orderRef",
  "fullAddress",
  "documentName",
];

const ALLOWED_ORDER_TYPES = ["medical", "billing", "employment", "xrays", "other"];
const ALLOWED_INJURY_TYPES = ["specific", "cumulative"];
const ALLOWED_CNR_DELIVERY = new Set(["email", "fax", "pickup"]);
const WORKFLOW_STAGE_NAMES = [
  "Review Records",
  "Serve",
  "SENT",
];
const WORKFLOW_STAGE_STATUSES = ["pending", "complete", "failed", "sent"];
const MAX_NOTE_LENGTH = FIELD_LIMITS.ORDER_NOTE;

const EMAIL_FIELDS = ["contact1Email", "contact2Email"];
const PHONE_FIELDS = [
  "phone",
  "fax",
  "contact1Phone",
  "contact1Fax",
  "contact2Phone",
  "contact2Fax",
];
const PAYMENT_PREFIXES = ["prepayment", "xray"];

function hasRecordTypesSelected(body = {}) {
  return [
    body.medicalRecords,
    body.billingRecords,
    body.employmentRecords,
    body.xrays,
    body.otherRecord,
  ].some(Boolean);
}

function hasPersonalDocument(body = {}) {
  if (body.hasDriverLicenseDocument === true || body.hasDriverLicenseDocument === "true") {
    return true;
  }
  if (body.hasPersonalDocument === true || body.hasPersonalDocument === "true") {
    return true;
  }
  if (body.additionalDocumentFile) return true;
  const docs = body.documents;
  if (Array.isArray(docs) && docs.length > 0) return true;
  if (typeof docs === "string" && docs.trim() && docs.trim() !== "[]") return true;
  return false;
}

function validatePersonalPortalOrderPayload(body = {}, options = {}) {
  const { requireOrderNumber = true } = options;
  const errors = [];

  if (requireOrderNumber) {
    if (isBlank(body.orderNumber)) {
      errors.push({ field: "orderNumber", message: "Order number is required" });
    } else {
      addMaxLengthError(errors, "orderNumber", body.orderNumber, 50);
      addNoHtmlMarkupError(errors, "orderNumber", body.orderNumber);
    }
  }

  if (isBlank(body.firstName)) {
    errors.push({ field: "firstName", message: "First name is required" });
  } else {
    addMaxLengthError(errors, "firstName", body.firstName, FIELD_LIMITS.VARCHAR_100);
    addPersonNameFormatError(errors, "firstName", body.firstName);
  }

  if (isBlank(body.lastName)) {
    errors.push({ field: "lastName", message: "Last name is required" });
  } else {
    addMaxLengthError(errors, "lastName", body.lastName, FIELD_LIMITS.VARCHAR_100);
    addPersonNameFormatError(errors, "lastName", body.lastName);
  }

  if (isBlank(body.dob)) {
    errors.push({ field: "dob", message: "Date of birth is required" });
  } else if (!isValidIsoDate(body.dob)) {
    errors.push({ field: "dob", message: "Enter a valid date of birth" });
  } else if (isFutureDate(body.dob)) {
    errors.push({ field: "dob", message: "DOB cannot be in the future" });
  }

  const facilityName = trimToString(body.facilityName);
  if (!facilityName && isBlank(body.facility)) {
    errors.push({
      field: "facilityName",
      message: "Treating facility is required",
    });
  } else if (facilityName) {
    addMaxLengthError(errors, "facilityName", facilityName, FIELD_LIMITS.VARCHAR_255);
    addNoHtmlMarkupError(errors, "facilityName", facilityName);
  }

  if (isBlank(body.injuryDateBegin)) {
    errors.push({
      field: "injuryDateBegin",
      message: "Specific dates needed: start date is required",
    });
  } else if (!isValidIsoDate(body.injuryDateBegin)) {
    errors.push({
      field: "injuryDateBegin",
      message: "Enter a valid start date",
    });
  }

  if (isBlank(body.injuryDateEnd)) {
    errors.push({
      field: "injuryDateEnd",
      message: "Specific dates needed: end date is required",
    });
  } else if (!isValidIsoDate(body.injuryDateEnd)) {
    errors.push({
      field: "injuryDateEnd",
      message: "Enter a valid end date",
    });
  } else if (
    !isBlank(body.injuryDateBegin) &&
    isValidIsoDate(body.injuryDateBegin) &&
    body.injuryDateEnd < body.injuryDateBegin
  ) {
    errors.push({
      field: "injuryDateEnd",
      message: "End date must be on or after start date",
    });
  }

  if (!hasRecordTypesSelected(body) && isBlank(body.type)) {
    errors.push({
      field: "type",
      message: "Select at least one record type needed",
    });
  }

  if (isBlank(body.driverLicenseNumber)) {
    errors.push({
      field: "driverLicenseNumber",
      message: "Driver's licence number is required",
    });
  } else {
    addMaxLengthError(
      errors,
      "driverLicenseNumber",
      body.driverLicenseNumber,
      50
    );
    addNoHtmlMarkupError(
      errors,
      "driverLicenseNumber",
      body.driverLicenseNumber
    );
  }

  if (!hasPersonalDocument(body)) {
    errors.push({
      field: "additionalDocumentFile",
      message: "Driver's licence / document is required",
    });
  }

  if (isBlank(body.specificDoctor)) {
    errors.push({ field: "specificDoctor", message: "Specific doctor is required" });
  } else {
    addMaxLengthError(
      errors,
      "specificDoctor",
      body.specificDoctor,
      FIELD_LIMITS.VARCHAR_200
    );
    addOrganizationNameFormatError(errors, "specificDoctor", body.specificDoctor);
  }

  // Optional format checks (non-required fields for personal)
  if (!isBlank(body.email) && !isValidEmail(trimToString(body.email))) {
    errors.push({ field: "email", message: "Enter a valid email address" });
  }
  if (!isBlank(body.ssn)) {
    const ssnError = getSsnValidationError(body.ssn);
    if (ssnError) {
      errors.push({ field: "ssn", message: ssnError });
    }
  }

  if (!isBlank(body.serveCompanyName)) {
    addMaxLengthError(
      errors,
      "serveCompanyName",
      body.serveCompanyName,
      FIELD_LIMITS.VARCHAR_255
    );
  }

  // Personal orders still need a facility id row (linked or placeholder) for DMS.
  if (!isBlank(body.facility)) {
    if (Number.isNaN(Number(body.facility)) || Number(body.facility) <= 0) {
      errors.push({ field: "facility", message: "Facility is invalid" });
    }
  }

  errors.push(...validateCnrFields(body));

  return { valid: errors.length === 0, errors };
}

function validateOrderPayload(body = {}, options = {}) {
  const { requireOrderNumber = true } = options;
  const errors = [];
  const isPersonalPortal =
    body.creationSource === "personal_portal" ||
    body.creation_source === "personal_portal";

  if (isPersonalPortal) {
    return validatePersonalPortalOrderPayload(body, { requireOrderNumber });
  }

  if (requireOrderNumber) {
    if (
      isBlank(body.orderNumber) ||
      isPendingAutoOrderNumber(body.orderNumber)
    ) {
      errors.push({ field: "orderNumber", message: "Order number is required" });
    } else {
      addMaxLengthError(errors, "orderNumber", body.orderNumber, 50);
      addNoHtmlMarkupError(errors, "orderNumber", body.orderNumber);
    }
  } else if (!isBlank(body.orderNumber)) {
    addMaxLengthError(errors, "orderNumber", body.orderNumber, 50);
    addNoHtmlMarkupError(errors, "orderNumber", body.orderNumber);
  }

  const facility = body.facility;

  if (isBlank(facility)) {
    errors.push({ field: "facility", message: "Facility is required" });
  } else if (Number.isNaN(Number(facility)) || Number(facility) <= 0) {
    errors.push({ field: "facility", message: "Facility is invalid" });
  }

  if (!hasRecordTypesSelected(body) && isBlank(body.type)) {
    errors.push({
      field: "type",
      message: "At least one record type is required",
    });
  } else if (
    !isBlank(body.type) &&
    !ALLOWED_ORDER_TYPES.includes(trimToString(body.type))
  ) {
    errors.push({ field: "type", message: "Type is invalid" });
  }

  if (isBlank(body.firstName)) {
    errors.push({ field: "firstName", message: "First name is required" });
  } else {
    addMaxLengthError(errors, "firstName", body.firstName, FIELD_LIMITS.VARCHAR_100);
    addPersonNameFormatError(errors, "firstName", body.firstName);
  }

  if (isBlank(body.lastName)) {
    errors.push({ field: "lastName", message: "Last name is required" });
  } else {
    addMaxLengthError(errors, "lastName", body.lastName, FIELD_LIMITS.VARCHAR_100);
    addPersonNameFormatError(errors, "lastName", body.lastName);
  }

  if (isBlank(body.serveCompanyName)) {
    errors.push({ field: "serveCompanyName", message: "Company name is required" });
  } else {
    addMaxLengthError(
      errors,
      "serveCompanyName",
      body.serveCompanyName,
      FIELD_LIMITS.VARCHAR_255
    );
    addOrganizationNameFormatError(errors, "serveCompanyName", body.serveCompanyName);
  }

  const providerEmail = trimToString(body.email);
  if (!isBlank(body.email)) {
    if (!isValidEmail(providerEmail)) {
      errors.push({ field: "email", message: "Enter a valid email address" });
    } else {
      addMaxLengthError(errors, "email", providerEmail, FIELD_LIMITS.VARCHAR_255);
    }
  }

  // Specific doctor is optional on standard new/edit orders.
  if (!isBlank(body.specificDoctor)) {
    addMaxLengthError(
      errors,
      "specificDoctor",
      body.specificDoctor,
      FIELD_LIMITS.VARCHAR_200
    );
    addOrganizationNameFormatError(errors, "specificDoctor", body.specificDoctor);
  }

  addMaxLengthError(errors, "middleName", body.middleName, FIELD_LIMITS.VARCHAR_100);
  addPersonNameFormatError(errors, "middleName", body.middleName);
  addMaxLengthError(errors, "aka", body.aka, FIELD_LIMITS.VARCHAR_150);
  addPersonNameFormatError(errors, "aka", body.aka);
  addMaxLengthError(errors, "defendant", body.defendant, FIELD_LIMITS.VARCHAR_200);
  addOrganizationNameFormatError(errors, "defendant", body.defendant);
  addMaxLengthError(errors, "address", body.address, FIELD_LIMITS.VARCHAR_255);
  addMaxLengthError(errors, "city", body.city, FIELD_LIMITS.VARCHAR_100);
  addMaxLengthError(errors, "specificRecord", body.specificRecord, FIELD_LIMITS.TEXT);
  addMaxLengthError(errors, "court", body.court, 50);
  addMaxLengthError(errors, "caseNumber", body.caseNumber, FIELD_LIMITS.VARCHAR_255);
  addMaxLengthError(errors, "recNumber", body.recNumber, 50);
  addMaxLengthError(errors, "orderRef", body.orderRef, 50);
  addMaxLengthError(errors, "contact1Name", body.contact1Name, FIELD_LIMITS.VARCHAR_150);
  addPersonNameFormatError(errors, "contact1Name", body.contact1Name);
  addMaxLengthError(errors, "contact1Title", body.contact1Title, FIELD_LIMITS.VARCHAR_100);
  addPersonNameFormatError(errors, "contact1Title", body.contact1Title);
  addMaxLengthError(errors, "contact2Name", body.contact2Name, FIELD_LIMITS.VARCHAR_150);
  addPersonNameFormatError(errors, "contact2Name", body.contact2Name);
  addMaxLengthError(errors, "contact2Title", body.contact2Title, FIELD_LIMITS.VARCHAR_100);
  addPersonNameFormatError(errors, "contact2Title", body.contact2Title);
  addMaxLengthError(errors, "fullAddress", body.fullAddress, FIELD_LIMITS.TEXT);
  addMaxLengthError(errors, "cnrReason", body.cnrReason, FIELD_LIMITS.TEXT);
  addNoHtmlMarkupError(errors, "cnrReason", body.cnrReason);
  addMaxLengthError(errors, "documentName", body.documentName, FIELD_LIMITS.VARCHAR_255);
  addNoHtmlMarkupErrors(errors, body, ORDER_FREE_TEXT_FIELDS);
  addNoHtmlMarkupError(errors, "documentName", body.documentName);

  if (!isBlank(body.ssn)) {
    const ssnError = getSsnValidationError(body.ssn);
    if (ssnError) {
      errors.push({ field: "ssn", message: ssnError });
    }
  }

  if (!isBlank(body.dob)) {
    if (!isValidIsoDate(body.dob)) {
      errors.push({ field: "dob", message: "Enter a valid date of birth" });
    } else if (isFutureDate(body.dob)) {
      errors.push({ field: "dob", message: "DOB cannot be in the future" });
    }
  }

  const zip = trimToString(body.zip);
  if (zip) {
    if (!isValidZip(zip)) {
      errors.push({
        field: "zip",
        message: ZIP_VALIDATION_MESSAGE,
      });
    } else {
      addMaxLengthError(errors, "zip", zip, ZIP_MAX_CHARS);
    }
  }

  const state = trimToString(body.state);
  if (state && state.length !== 2) {
    errors.push({ field: "state", message: "State must be 2 letters" });
  }

  EMAIL_FIELDS.forEach((field) => {
    const value = trimToString(body[field]);
    if (value && !isValidEmail(value)) {
      errors.push({ field, message: "Enter a valid email address" });
    }
    addMaxLengthError(errors, field, value, FIELD_LIMITS.VARCHAR_255);
  });

  PHONE_FIELDS.forEach((field) => {
    const value = body[field];
    if (value && getDigits(value).length !== 10) {
      errors.push({ field, message: "Enter a valid 10 digit number" });
    }
    addMaxLengthError(errors, field, value, 20);
  });

  PAYMENT_PREFIXES.forEach((prefix) => {
    const checkField = `${prefix}Check`;
    const paidField = `${prefix}Paid`;
    const checkValue = trimToString(body[checkField]);
    const isCompanyPortalPrepayment =
      trimToString(body.creationSource) === "company_portal" &&
      prefix === "prepayment";
    const isPrepaymentReceipt =
      prefix === "prepayment" &&
      (checkValue === "STRIPE-PORTAL" || /^[\d-]+$/.test(checkValue));

    // Company portal prepayment check may include letters / symbols.
    if (
      !isBlank(body[checkField]) &&
      !isCompanyPortalPrepayment &&
      !isPrepaymentReceipt &&
      !/^\d+$/.test(checkValue)
    ) {
      errors.push({
        field: checkField,
        message: "Check number must contain only numbers",
      });
    }

    if (!isBlank(body[paidField]) && !isValidMoney(body[paidField])) {
      errors.push({ field: paidField, message: "Enter a valid amount" });
    }

    const paidAmount = isBlank(body[paidField])
      ? null
      : Number(String(body[paidField]).replace(/[^\d.]/g, ""));
    const creationSource = trimToString(body.creationSource);
    const isPortalOrder =
      creationSource === "personal_portal" ||
      creationSource === "company_portal";

    if (
      prefix === "prepayment" &&
      !isPortalOrder &&
      paidAmount != null &&
      !Number.isNaN(paidAmount) &&
      paidAmount > 15
    ) {
      errors.push({
        field: paidField,
        message:
          "Paid amount cannot exceed the outstanding due amount.",
      });
    }

    addMaxLengthError(errors, checkField, body[checkField], 50);
    addOptionalIsoDateError(errors, `${prefix}Date`, body[`${prefix}Date`]);
    const memoField = `${prefix}Memo`;
    addMaxLengthError(errors, memoField, body[memoField], FIELD_LIMITS.TEXT);
    addNoHtmlMarkupError(errors, memoField, body[memoField]);
  });

  [
    "dateServed",
    "depoDueDate",
    "deliveryDate",
    "subpoenaDate",
    "dateRequested",
    "readyDate",
    "invoiceDate",
    "xrayInvoiceDate",
    "cnrDateSent",
  ].forEach((field) => addOptionalIsoDateError(errors, field, body[field]));

  errors.push(...validateInjuryFields(body));
  errors.push(...validateCnrFields(body));

  return { valid: errors.length === 0, errors };
}

function validateInjuryFields(body = {}) {
  const errors = [];
  const injuryType = trimToString(body.injuryType);

  if (injuryType && !ALLOWED_INJURY_TYPES.includes(injuryType)) {
    errors.push({ field: "injuryType", message: "Injury type is invalid" });
    return errors;
  }

  if (!injuryType) {
    return errors;
  }

  if (injuryType === "specific") {
    if (isBlank(body.injuryDate)) {
      errors.push({ field: "injuryDate", message: "Injury date is required" });
    } else if (!isValidIsoDate(body.injuryDate)) {
      errors.push({ field: "injuryDate", message: "Enter a valid injury date" });
    }
    return errors;
  }

  const begin = trimToString(body.injuryDateBegin);
  const end = trimToString(body.injuryDateEnd);

  if (!begin) {
    errors.push({
      field: "injuryDateBegin",
      message: "Start date is required",
    });
  } else if (!isValidIsoDate(begin)) {
    errors.push({
      field: "injuryDateBegin",
      message: "Enter a valid start date",
    });
  }

  if (!end) {
    errors.push({
      field: "injuryDateEnd",
      message: "End date is required",
    });
  } else if (!isValidIsoDate(end)) {
    errors.push({
      field: "injuryDateEnd",
      message: "Enter a valid end date",
    });
  }

  if (begin && end && isValidIsoDate(begin) && isValidIsoDate(end) && end < begin) {
    errors.push({
      field: "injuryDateEnd",
      message: "End date must be on or after start date",
    });
  }

  return errors;
}

function validateCnrFields(body = {}) {
  const errors = [];

  if (!body.certificateNoRecords) {
    return errors;
  }

  const delivery = trimToString(body.cnrDelivery);

  if (delivery && !ALLOWED_CNR_DELIVERY.has(delivery)) {
    errors.push({ field: "cnrDelivery", message: "Invalid delivery method" });
  }

  if (
    delivery &&
    ALLOWED_CNR_DELIVERY.has(delivery) &&
    isBlank(body.cnrDateSent)
  ) {
    errors.push({
      field: "cnrDateSent",
      message: "Date is required for the selected delivery method",
    });
  }

  return errors;
}

function validateCreateOrder(body = {}) {
  return validateOrderPayload(body, { requireOrderNumber: true });
}

function validateUpdateOrder(body = {}) {
  return validateOrderPayload(body, { requireOrderNumber: true });
}

function validateOrderNote(body = {}) {
  const errors = [];
  const note = trimToString(body.note);

  if (!note) {
    errors.push({ field: "note", message: "Note text is required" });
  } else if (note.length > MAX_NOTE_LENGTH) {
    errors.push({
      field: "note",
      message: `Note cannot be more than ${MAX_NOTE_LENGTH} characters`,
    });
  } else {
    addNoHtmlMarkupError(errors, "note", note);
  }

  return { valid: errors.length === 0, errors };
}

function validateOrderFacilityUpdate(body = {}) {
  const errors = [];
  const facility = body.facility;

  if (isBlank(facility)) {
    errors.push({ field: "facility", message: "Facility is required" });
  } else if (Number.isNaN(Number(facility)) || Number(facility) <= 0) {
    errors.push({ field: "facility", message: "Facility is invalid" });
  }

  return { valid: errors.length === 0, errors };
}

function validateWorkflowStageUpdate(body = {}) {
  const errors = [];

  if (!WORKFLOW_STAGE_NAMES.includes(body.stageName)) {
    errors.push({ field: "stageName", message: "Invalid workflow stage" });
  }

  if (!WORKFLOW_STAGE_STATUSES.includes(body.stageStatus)) {
    errors.push({
      field: "stageStatus",
      message: "Invalid workflow stage status",
    });
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateCreateOrder,
  validateUpdateOrder,
  validateOrderFacilityUpdate,
  validateOrderNote,
  validateWorkflowStageUpdate,
  ALLOWED_ORDER_TYPES,
  WORKFLOW_STAGE_NAMES,
  WORKFLOW_STAGE_STATUSES,
};
