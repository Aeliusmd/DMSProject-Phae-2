import {
  hasFormRecordTypesSelected,
} from "@/lib/orders/recordTypeUtils";
import {
  validatePersonName,
  validateOrganizationName,
  validateNoHtmlMarkup,
  addNoHtmlMarkupFieldErrors,
} from "@/lib/validations/nameValidation";
import {
  ZIP_VALIDATION_MESSAGE,
  isValidZip,
  sanitizeZip,
} from "@/lib/validations/zipUtils";

const AUTO_PENDING_ORDER_PREFIX = "AUTO-PENDING-";

export const immediateRequiredFields = [
  "orderNumber",
  "facility",
  "type",
  "firstName",
  "lastName",
  "serveCompanyName",
];

export const personalImmediateRequiredFields = [
  "orderNumber",
  "firstName",
  "lastName",
  "dob",
  "facility",
  "facilityName",
  "specificDoctor",
  "injuryDateBegin",
  "injuryDateEnd",
  "type",
  "driverLicenseNumber",
  "additionalDocumentFile",
];

export function getImmediateRequiredFields(data = {}) {
  return data.creationSource === "personal_portal"
    ? personalImmediateRequiredFields
    : immediateRequiredFields;
}

export const emailFields = ["contact1Email", "contact2Email"];

export const phoneFields = [
  "phone",
  "fax",
  "contact1Phone",
  "contact1Fax",
  "contact2Phone",
  "contact2Fax",
];

export const numericOnlyFields = [
  "prepaymentCheck",
  "xrayCheck",
];

export const moneyFields = [
  "prepaymentPaid",
  "xrayPaid",
  "xrayDue",
];

export const paymentPrefixes = ["prepayment", "xray"];

function hasPersonalDocument(data = {}) {
  if (data.hasDriverLicenseDocument || data.hasPersonalDocument) return true;
  if (Array.isArray(data.documents) && data.documents.length > 0) return true;
  if (data.additionalDocumentFile) return true;
  return false;
}

function validatePersonalPortalOrderForm(data, fileErrors = {}) {
  const errors = {};

  if (!data.orderNumber?.trim()) {
    errors.orderNumber = "Order number is required";
  } else {
    const orderNumberError = validateNoHtmlMarkup(data.orderNumber, {
      fieldLabel: "Order number",
    });
    if (orderNumberError) errors.orderNumber = orderNumberError;
    else if (data.orderNumber.trim().length > 50) {
      errors.orderNumber = "Order number cannot be more than 50 characters";
    }
  }

  if (!`${data.firstName || ""}`.trim()) {
    errors.firstName = "First name is required";
  } else {
    const firstNameError = validatePersonName(data.firstName, {
      fieldLabel: "First name",
    });
    if (firstNameError) errors.firstName = firstNameError;
  }

  if (!`${data.lastName || ""}`.trim()) {
    errors.lastName = "Last name is required";
  } else {
    const lastNameError = validatePersonName(data.lastName, {
      fieldLabel: "Last name",
    });
    if (lastNameError) errors.lastName = lastNameError;
  }

  if (!`${data.dob || ""}`.trim()) {
    errors.dob = "Date of birth is required";
  } else if (isFutureDate(data.dob)) {
    errors.dob = "DOB cannot be in the future";
  }

  if (
    !`${data.facilityName || ""}`.trim() &&
    !`${data.facility || ""}`.trim()
  ) {
    errors.facilityName = "Treating facility is required";
    errors.facility = "Treating facility is required";
  }

  if (!`${data.specificDoctor || ""}`.trim()) {
    errors.specificDoctor = "Specific doctor is required";
  } else {
    const doctorError = validateOrganizationName(data.specificDoctor, {
      fieldLabel: "Specific doctor",
    });
    if (doctorError) errors.specificDoctor = doctorError;
    else if (data.doctorNotInSystem) {
      errors.specificDoctor =
        "Add this doctor to the facility to complete the order";
    }
  }

  if (!`${data.injuryDateBegin || ""}`.trim()) {
    errors.injuryDateBegin = "Start date is required";
  }
  if (!`${data.injuryDateEnd || ""}`.trim()) {
    errors.injuryDateEnd = "End date is required";
  } else if (
    data.injuryDateBegin &&
    data.injuryDateEnd &&
    data.injuryDateEnd < data.injuryDateBegin
  ) {
    errors.injuryDateEnd = "End date must be on or after start date";
  }

  if (!hasFormRecordTypesSelected(data)) {
    errors.type = "Select at least one record type";
  }

  if (!`${data.driverLicenseNumber || ""}`.trim()) {
    errors.driverLicenseNumber = "Driver's licence number is required";
  } else {
    const licenseError = validateNoHtmlMarkup(data.driverLicenseNumber, {
      fieldLabel: "Driver's licence number",
    });
    if (licenseError) errors.driverLicenseNumber = licenseError;
  }

  if (!hasPersonalDocument(data)) {
    errors.additionalDocumentFile =
      "Driver's licence / document is required";
  }

  if (data.ssn) {
    const ssnError = getSsnValidationError(data.ssn);
    if (ssnError) errors.ssn = ssnError;
  }

  if (data.email?.trim() && !isValidEmail(data.email)) {
    errors.email = "Enter a valid email address";
  }

  if (fileErrors.additionalDocumentFile) {
    errors.additionalDocumentFile = fileErrors.additionalDocumentFile;
  }
  if (fileErrors.subpoenaFile) {
    errors.subpoenaFile = fileErrors.subpoenaFile;
  }

  if (data.documentName && !data.additionalDocumentFile && !hasPersonalDocument(data)) {
    errors.additionalDocumentFile = "Please choose a document file";
  }

  addNoHtmlMarkupFieldErrors(errors, data, {
    specificRecord: "Specific record",
    documentName: "Document name",
  });

  return errors;
}

export function validateNewOrderForm(data, fileErrors = {}) {
  const errors = {};
  const isPersonalPortal = data.creationSource === "personal_portal";

  if (isPersonalPortal) {
    return validatePersonalPortalOrderForm(data, fileErrors);
  }

  if (
    !data.orderNumber?.trim() ||
    data.orderNumber.trim().startsWith(AUTO_PENDING_ORDER_PREFIX)
  ) {
    errors.orderNumber = "Order number is required";
  } else {
    const orderNumberError = validateNoHtmlMarkup(data.orderNumber, {
      fieldLabel: "Order number",
    });
    if (orderNumberError) errors.orderNumber = orderNumberError;
    else if (data.orderNumber.trim().length > 50) {
      errors.orderNumber = "Order number cannot be more than 50 characters";
    }
  }

  if (!data.facility) errors.facility = "Facility is required";
  if (!hasFormRecordTypesSelected(data)) {
    errors.type = "Select at least one record type";
  }
  if (!data.firstName.trim()) errors.firstName = "First name is required";
  else {
    const firstNameError = validatePersonName(data.firstName, {
      fieldLabel: "First name",
    });
    if (firstNameError) errors.firstName = firstNameError;
  }

  if (!data.lastName.trim()) errors.lastName = "Last name is required";
  else {
    const lastNameError = validatePersonName(data.lastName, {
      fieldLabel: "Last name",
    });
    if (lastNameError) errors.lastName = lastNameError;
  }

  if (!data.serveCompanyName.trim()) {
    errors.serveCompanyName = "Company name is required";
  } else {
    const companyError = validateOrganizationName(data.serveCompanyName, {
      fieldLabel: "Company name",
    });
    if (companyError) errors.serveCompanyName = companyError;
  }

  if (data.email?.trim()) {
    if (!isValidEmail(data.email)) {
      errors.email = "Enter a valid email address";
    }
  }

  // Specific doctor is optional on standard new/edit orders.
  if (data.specificDoctor?.trim()) {
    const doctorError = validateOrganizationName(data.specificDoctor, {
      fieldLabel: "Specific doctor",
    });
    if (doctorError) errors.specificDoctor = doctorError;
  }

  const middleNameError = validatePersonName(data.middleName, {
    fieldLabel: "Middle name",
  });
  if (middleNameError) errors.middleName = middleNameError;

  const akaError = validatePersonName(data.aka, { fieldLabel: "AKA" });
  if (akaError) errors.aka = akaError;

  const defendantError = validateOrganizationName(data.defendant, {
    fieldLabel: "Defendant",
  });
  if (defendantError) errors.defendant = defendantError;

  const cnrReasonError = validateNoHtmlMarkup(data.cnrReason, {
    fieldLabel: "CNR reason",
  });
  if (cnrReasonError) errors.cnrReason = cnrReasonError;

  addNoHtmlMarkupFieldErrors(errors, data, {
    address: "Address",
    city: "City",
    specificRecord: "Specific record",
    court: "Court",
    caseNumber: "Case number",
    recNumber: "REC number",
    orderRef: "Order reference",
    fullAddress: "Full address",
    prepaymentMemo: "Prepayment memo",
    custodianMemo: "Custodian memo",
    xrayMemo: "X-Ray memo",
  });

  if (data.ssn) {
    const ssnError = getSsnValidationError(data.ssn);
    if (ssnError) errors.ssn = ssnError;
  }

  if (data.dob && isFutureDate(data.dob)) {
    errors.dob = "DOB cannot be in the future";
  }

  if (data.zip && !isValidZip(data.zip)) {
    errors.zip = ZIP_VALIDATION_MESSAGE;
  }

  if (data.state && data.state.length !== 2) {
    errors.state = "State must be 2 letters";
  }

  emailFields.forEach((field) => {
    if (data[field] && !isValidEmail(data[field])) {
      errors[field] = "Enter a valid email address";
    }
  });

  phoneFields.forEach((field) => {
    if (data[field] && getDigits(data[field]).length !== 10) {
      errors[field] = "Enter a valid 10 digit number";
    }
  });

  paymentPrefixes.forEach((prefix) => {
    const checkField = `${prefix}Check`;
    const paidField = `${prefix}Paid`;
    const isPersonalPortalPrepayment =
      data.creationSource === "personal_portal" && prefix === "prepayment";
    const isCompanyPortalPrepayment =
      data.creationSource === "company_portal" && prefix === "prepayment";

    // Company portal prepayment check may include letters / symbols.
    if (
      data[checkField] &&
      !isCompanyPortalPrepayment &&
      !isPersonalPortalPrepayment &&
      !/^\d+$/.test(data[checkField])
    ) {
      errors[checkField] = "Check number must contain only numbers";
    }

    if (
      data[checkField] &&
      isPersonalPortalPrepayment &&
      data[checkField] !== "STRIPE-PORTAL" &&
      !/^[\d-]+$/.test(data[checkField])
    ) {
      errors[checkField] = "Receipt number must contain only numbers";
    }

    if (data[paidField] && !isValidMoney(data[paidField])) {
      errors[paidField] = "Enter a valid amount";
    }
  });

  if (fileErrors.subpoenaFile) {
    errors.subpoenaFile = fileErrors.subpoenaFile;
  }

  if (fileErrors.additionalDocumentFile) {
    errors.additionalDocumentFile = fileErrors.additionalDocumentFile;
  }

  if (data.injuryType === "cumulative") {
    if (!data.injuryDateBegin) {
      errors.injuryDateBegin = "Start date is required";
    }

    if (!data.injuryDateEnd) {
      errors.injuryDateEnd = "End date is required";
    }

    if (
      data.injuryDateBegin &&
      data.injuryDateEnd &&
      data.injuryDateEnd < data.injuryDateBegin
    ) {
      errors.injuryDateEnd = "End date must be on or after start date";
    }
  }

  if (data.injuryType === "specific" && !data.injuryDate) {
    errors.injuryDate = "Injury date is required";
  }

  if (
    data.certificateNoRecords &&
    data.cnrDelivery &&
    ["email", "fax", "pickup"].includes(data.cnrDelivery) &&
    !data.cnrDateSent
  ) {
    errors.cnrDateSent = "Date is required for the selected delivery method";
  }

  return errors;
}

export function validateFile(file, { pdfOnly = false } = {}) {
  if (!file) return "";

  const allowedTypes = pdfOnly
    ? ["application/pdf"]
    : [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "image/jpeg",
        "image/png",
      ];

  const maxSize = 10 * 1024 * 1024;

  if (!allowedTypes.includes(file.type)) {
    return pdfOnly
      ? "Only PDF files are allowed for subpoena"
      : "Only PDF, Word, JPG, or PNG files are allowed";
  }

  // Some browsers leave type empty; fall back to extension for PDF-only.
  if (pdfOnly && !file.type) {
    const name = `${file.name || ""}`.toLowerCase();
    if (!name.endsWith(".pdf")) {
      return "Only PDF files are allowed for subpoena";
    }
  }

  if (file.size > maxSize) {
    return "File size must be less than 10MB";
  }

  return "";
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

export function isValidSSN(ssn) {
  return getSsnValidationError(ssn) === null;
}

export function getSsnValidationError(
  ssn,
  { maskedExample = "XXX-XX-1234" } = {}
) {
  const trimmed = String(ssn || "").trim();
  if (!trimmed) return null;

  if (/^XXX-XX-\d{4}$/i.test(trimmed)) return null;
  if (/^\d{3}-\d{2}-\d{4}$/.test(trimmed)) return null;
  if (/^\d{4}$/.test(trimmed)) return null;

  const digits = getDigits(trimmed);
  if (digits.length > 0 && digits.length < 4) {
    return "SSN must include at least the last 4 digits";
  }

  if (
    /^\d{1,3}(-\d{0,2}(-\d{0,4})?)?$/.test(trimmed) ||
    (digits.length >= 5 && digits.length < 9)
  ) {
    return `Enter the complete SSN (123-45-6789 or ${maskedExample})`;
  }

  return `Enter SSN as 123-45-6789 or ${maskedExample}`;
}

export function isValidMoney(value) {
  return /^\d+(\.\d{1,2})?$/.test(value);
}

export function isFutureDate(dateValue) {
  const selectedDate = new Date(dateValue);
  const today = new Date();

  selectedDate.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);

  return selectedDate > today;
}

export function getDigits(value) {
  return value.replace(/\D/g, "");
}

export function formatPhone(value) {
  const digits = getDigits(value).slice(0, 10);

  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;

  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function formatZip(value) {
  return sanitizeZip(value);
}

export function formatSSN(value) {
  const trimmed = String(value || "").trim();
  if (/^XXX-XX-\d{4}$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  const digits = getDigits(value).slice(0, 9);

  if (digits.length <= 3) return digits;
  if (digits.length <= 5) return `${digits.slice(0, 3)}-${digits.slice(3)}`;

  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

export function formatMaskedSSN(value) {
  const digits = getDigits(value);
  if (digits.length < 4) return "";

  return `XXX-XX-${digits.slice(-4)}`;
}

export function formatMoneyInput(value) {
  const cleaned = value.replace(/[^\d.]/g, "");
  const parts = cleaned.split(".");

  if (parts.length === 1) return parts[0];

  return `${parts[0]}.${parts.slice(1).join("").slice(0, 2)}`;
}