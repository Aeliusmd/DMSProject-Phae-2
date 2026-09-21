import { formatMaskedSSN } from "@/lib/validations/newOrderValidation";
import { sanitizeZip } from "@/lib/validations/zipUtils";

const ORDER_TYPE_KEYWORDS = {
  billing: ["billing"],
  employment: ["employment"],
  xrays: ["xray", "x-rays", "x-ray", "xrays"],
  medical: ["medical"],
};

const RECORD_FLAG_MAP = {
  medical: "medicalRecords",
  billing: "billingRecords",
  employment: "employmentRecords",
  xrays: "xrays",
};

export function normalizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getFacilityLabel(facility) {
  return facility?.facility || facility?.facilityName || facility?.name || "";
}

function getProviderLabel(provider) {
  return provider?.companyName || provider?.company_name || "";
}

export function findFacilityMatch(name, facilityList = []) {
  const normalized = normalizeForMatch(name);
  if (!normalized || !facilityList.length) return null;

  const exact = facilityList.find(
    (facility) => normalizeForMatch(getFacilityLabel(facility)) === normalized
  );
  if (exact) return exact;

  return (
    facilityList.find((facility) => {
      const facilityName = normalizeForMatch(getFacilityLabel(facility));
      return (
        facilityName &&
        (normalized.includes(facilityName) || facilityName.includes(normalized))
      );
    }) || null
  );
}

export function findProviderMatch(companyName, providerList = []) {
  const normalized = normalizeForMatch(companyName);
  if (!normalized || !providerList.length) return null;

  const exact = providerList.find(
    (provider) => normalizeForMatch(getProviderLabel(provider)) === normalized
  );
  if (exact) return exact;

  return (
    providerList.find((provider) => {
      const providerName = normalizeForMatch(getProviderLabel(provider));
      return (
        providerName &&
        (normalized.includes(providerName) || providerName.includes(normalized))
      );
    }) || null
  );
}

export function mapRecordTypeToOrderType(recordType, requestedRecord) {
  const combined = `${recordType || ""} ${requestedRecord || ""}`.toLowerCase();

  for (const [type, keywords] of Object.entries(ORDER_TYPE_KEYWORDS)) {
    if (keywords.some((keyword) => combined.includes(keyword))) {
      return type;
    }
  }

  if (/\bother\b/.test(combined)) {
    return "other";
  }

  return null;
}

function applyRecordFlags(updates, recordText) {
  const text = recordText.toLowerCase();
  if (text.includes("medical")) updates.medicalRecords = true;
  if (text.includes("billing")) updates.billingRecords = true;
  if (text.includes("employment")) updates.employmentRecords = true;
  if (text.includes("xray") || text.includes("x-ray")) {
    updates.xrays = true;
  }
}

export function normalizeAutofillCheckNumber(value) {
  if (!value) return "";

  let text = String(value).trim();

  while (/^#\s*/.test(text)) {
    text = text.replace(/^#\s*/, "");
  }

  return text.trim();
}

export function normalizeAutofillAmount(value) {
  if (!value) return "";
  return String(value).replace(/[^\d.]/g, "");
}

export function normalizeAutofillSSN(value) {
  if (!value) return "";
  const trimmed = String(value).trim();
  // Prefer full ###-##-#### when all digits exist; keep XXX-XX-#### only if masked.
  if (/^XXX-XX-\d{4}$/i.test(trimmed)) {
    return `XXX-XX-${trimmed.slice(-4)}`;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length >= 9) {
    const nine = digits.slice(-9);
    return `${nine.slice(0, 3)}-${nine.slice(3, 5)}-${nine.slice(5)}`;
  }
  if (digits.length >= 4) return formatMaskedSSN(trimmed);
  return "";
}

const DATE_TOKEN_PATTERN =
  /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})/g;

const DATE_RANGE_SEPARATOR =
  /\s*(?:-|–|—|\bto\b|\bthrough\b|\bthru\b)\s*/i;

export function parseSingleDateToInput(value) {
  if (!value) return "";

  const trimmed = String(value).trim();
  if (!trimmed) return "";

  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slash = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (slash) {
    let year = Number(slash[3]);
    if (year < 100) year += 2000;
    const month = String(slash[1]).padStart(2, "0");
    const day = String(slash[2]).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const embeddedIso = trimmed.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (embeddedIso) {
    return `${embeddedIso[1]}-${embeddedIso[2]}-${embeddedIso[3]}`;
  }

  const embeddedSlash = trimmed.match(
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/
  );
  if (embeddedSlash) {
    let year = Number(embeddedSlash[3]);
    if (year < 100) year += 2000;
    const month = String(embeddedSlash[1]).padStart(2, "0");
    const day = String(embeddedSlash[2]).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  return "";
}

function extractDateTokens(text) {
  return [...String(text || "").matchAll(DATE_TOKEN_PATTERN)]
    .map((match) => parseSingleDateToInput(match[1]))
    .filter(Boolean);
}

export function applyDateOfInjuryFromHints(updates, hints = {}) {
  const parsedFromHint =
    parseSingleDateToInput(hints.dateOfInjury) ||
    parseSingleDateToInput(hints.date_of_injury);

  if (!hints.dateOfInjuryText && parsedFromHint) {
    updates.injuryType = "specific";
    updates.injuryDate = parsedFromHint;
    updates.injuryDateBegin = "";
    updates.injuryDateEnd = "";
    return;
  }

  const rawText =
    hints.dateOfInjuryText ||
    hints.dateOfInjury ||
    hints.date_of_injury;
  if (!rawText) return;

  const text = String(rawText).trim();
  if (!text) return;

  const rangeParts = text.split(DATE_RANGE_SEPARATOR).filter(Boolean);
  if (rangeParts.length >= 2) {
    const begin = parseSingleDateToInput(rangeParts[0]);
    const end = parseSingleDateToInput(rangeParts[rangeParts.length - 1]);

    if (begin && end && begin !== end) {
      updates.injuryType = "cumulative";
      updates.injuryDateBegin = begin;
      updates.injuryDateEnd = end;
      updates.injuryDate = "";
      return;
    }
  }

  const datesInText = extractDateTokens(text);
  const cumulativeHint = /\b(cumulative|continuous\s+trauma|\bct\b)/i.test(
    text
  );

  if (cumulativeHint && datesInText.length >= 1) {
    updates.injuryType = "cumulative";
    updates.injuryDateBegin = datesInText[0];
    updates.injuryDateEnd = datesInText[1] || "";
    updates.injuryDate = "";
    return;
  }

  if (datesInText.length >= 2) {
    updates.injuryType = "cumulative";
    updates.injuryDateBegin = datesInText[0];
    updates.injuryDateEnd = datesInText[1];
    updates.injuryDate = "";
    return;
  }

  const single =
    datesInText[0] ||
    parseSingleDateToInput(text) ||
    parseSingleDateToInput(hints.dateOfInjury);

  if (single) {
    updates.injuryType = "specific";
    updates.injuryDate = single;
    updates.injuryDateBegin = "";
    updates.injuryDateEnd = "";
  }
}

function withSanitizedZip(parsed) {
  const zip = sanitizeZip(parsed.zip || "");
  const city = `${parsed.city || ""}`.trim();
  const state = `${parsed.state || ""}`.trim();

  return {
    ...parsed,
    city,
    state,
    zip,
    cityNeedsRecheck: !city && Boolean(state || zip),
  };
}

function normalizeAddressText(fullAddress) {
  return String(fullAddress || "")
    .replace(/[;\n\r]+/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/,(?:\s*,)+/g, ",")
    .trim();
}

function looksLikeAddressSegment(segment = "") {
  const text = `${segment || ""}`.trim();
  if (!text) return false;

  return (
    /^\d/.test(text) ||
    /^(suite|ste\.?|apt\.?|unit|p\.?\s*o\.?\s*box)\b/i.test(text) ||
    /\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|hwy|highway|ct|court|plaza|pkwy|parkway)\b/i.test(
      text
    ) ||
    /\b[A-Za-z]{2}\s+\d{5}(?:-\d{4})?\b/.test(text)
  );
}

function looksLikeCityName(segment = "") {
  const text = `${segment || ""}`.trim();
  if (!text) return false;
  if (looksLikeAddressSegment(text)) return false;
  if (text.split(/\s+/).length > 4) return false;
  return /^[A-Za-z][A-Za-z.'\- ]*$/.test(text);
}

export function parseUsAddress(fullAddress) {
  const trimmed = normalizeAddressText(fullAddress);
  if (!trimmed) {
    return withSanitizedZip({ address: "", city: "", state: "", zip: "" });
  }

  const parts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);

  if (parts.length === 1) {
    const inlineMatch = trimmed.match(
      /^(.+?)\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/
    );

    if (inlineMatch) {
      const remainder = inlineMatch[1].trim();
      const state = inlineMatch[2].toUpperCase();
      const zip = inlineMatch[3];

      if (looksLikeCityName(remainder)) {
        return withSanitizedZip({
          address: "",
          city: remainder,
          state,
          zip,
        });
      }

      return withSanitizedZip({
        address: remainder,
        city: "",
        state,
        zip,
      });
    }

    return withSanitizedZip({ address: trimmed, city: "", state: "", zip: "" });
  }

  const last = parts[parts.length - 1];
  const stateZipMatch = last.match(/^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);

  if (stateZipMatch) {
    const state = stateZipMatch[1].toUpperCase();
    const zip = stateZipMatch[2];
    const cityCandidate = parts[parts.length - 2] || "";

    if (looksLikeCityName(cityCandidate)) {
      return withSanitizedZip({
        address: parts.slice(0, -2).join(", "),
        city: cityCandidate,
        state,
        zip,
      });
    }

    return withSanitizedZip({
      address: parts.slice(0, -1).join(", "),
      city: "",
      state,
      zip,
    });
  }

  const cityStateZipMatch = last.match(
    /^(.+?)\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/
  );

  if (cityStateZipMatch) {
    const cityCandidate = cityStateZipMatch[1].trim();
    const state = cityStateZipMatch[2].toUpperCase();
    const zip = cityStateZipMatch[3];

    if (looksLikeCityName(cityCandidate)) {
      return withSanitizedZip({
        address: parts.slice(0, -1).join(", "),
        city: cityCandidate,
        state,
        zip,
      });
    }

    return withSanitizedZip({
      address: [...parts.slice(0, -1), cityCandidate].filter(Boolean).join(", "),
      city: "",
      state,
      zip,
    });
  }

  return withSanitizedZip({
    address: trimmed,
    city: "",
    state: "",
    zip: "",
  });
}

/**
 * Split "Facility Name, 123 Main St, City, CA 90017" into { name, address }.
 */
export function splitNameAndAddress(raw) {
  const text = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return { name: "", address: "" };
  }

  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length >= 2) {
    return {
      name: lines[0],
      address: lines.slice(1).join(", "),
    };
  }

  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);

  if (parts.length >= 2) {
    let addressStart = -1;

    for (let index = 1; index < parts.length; index += 1) {
      if (looksLikeAddressSegment(parts[index])) {
        addressStart = index;
        break;
      }
    }

    if (addressStart > 0) {
      return {
        name: parts.slice(0, addressStart).join(", "),
        address: parts.slice(addressStart).join(", "),
      };
    }
  }

  const inlineMatch = text.match(/^(.+?)\s+(\d{1,6}\s+.+)$/);
  if (inlineMatch && looksLikeAddressSegment(inlineMatch[2])) {
    return {
      name: inlineMatch[1].trim(),
      address: inlineMatch[2].trim(),
    };
  }

  return { name: text, address: "" };
}

function resolveFacilityLabelFromHints(hints = {}) {
  const fromFacilityName = splitNameAndAddress(hints.facilityName || "");
  if (fromFacilityName.name && fromFacilityName.address) {
    return fromFacilityName;
  }

  const fromCustomer = splitNameAndAddress(hints.customer || "");
  if (fromCustomer.name) {
    return {
      name: fromCustomer.name,
      address: fromCustomer.address || fromFacilityName.address || "",
    };
  }

  return {
    name: fromFacilityName.name || hints.facilityName || hints.customer || "",
    address: fromFacilityName.address || "",
  };
}

function applyParsedServeAddress(updates, fullAddress) {
  const parsed = parseUsAddress(fullAddress);
  updates.address = parsed.address || String(fullAddress).trim();

  if (!updates.city && parsed.city) updates.city = parsed.city;
  if (!updates.state && parsed.state) updates.state = parsed.state;
  if (!updates.zip && parsed.zip) updates.zip = sanitizeZip(parsed.zip);
}

function fillMissingServeAddressParts(updates) {
  if (!updates.address || (updates.city && updates.state && updates.zip)) {
    return;
  }

  const parsed = parseUsAddress(updates.address);
  if (!parsed.address) return;

  updates.address = parsed.address;
  if (!updates.city && parsed.city) updates.city = parsed.city;
  if (!updates.state && parsed.state) updates.state = parsed.state;
  if (!updates.zip && parsed.zip) updates.zip = sanitizeZip(parsed.zip);
}

export function mapOrderHintsToForm(hints, { facilityList = [], providerList = [] } = {}) {
  if (!hints) {
    return { updates: {}, meta: {} };
  }

  const updates = {};
  const meta = {};

  if (hints.orderNumber) updates.orderNumber = hints.orderNumber;
  if (hints.recNumber) updates.recNumber = hints.recNumber;
  if (hints.caseName) updates.caseNumber = hints.caseName;
  if (hints.ssn) {
    const formattedSsn = normalizeAutofillSSN(hints.ssn);
    if (formattedSsn) updates.ssn = formattedSsn;
  }
  if (hints.dateOfBirth) {
    updates.dob =
      parseSingleDateToInput(hints.dateOfBirth) || hints.dateOfBirth;
  }
  applyDateOfInjuryFromHints(updates, hints);
  if (hints.extractedDoctorName) {
    meta.extractedDoctorName = hints.extractedDoctorName;
  } else if (hints.specificDoctor && !hints.specificDoctorIsDefault) {
    meta.extractedDoctorName = hints.specificDoctor;
  }
  if (hints.doctorAddress) updates.fullAddress = hints.doctorAddress;
  if (hints.subpoenaDate) updates.subpoenaDate = hints.subpoenaDate;
  if (hints.dateRequested) {
    updates.dateRequested =
      parseSingleDateToInput(hints.dateRequested) || hints.dateRequested;
  }
  if (hints.depoDueDate) updates.depoDueDate = hints.depoDueDate;
  if (hints.requestedRecord) updates.specificRecord = hints.requestedRecord;
  if (hints.amount) {
    const amount = normalizeAutofillAmount(hints.amount);
    if (amount) {
      updates.prepaymentPaid = amount;
    }
  }
  if (hints.chequeDate) updates.prepaymentDate = hints.chequeDate;
  if (hints.chequeNumber) {
    const checkNumber = normalizeAutofillCheckNumber(hints.chequeNumber);
    if (checkNumber) updates.prepaymentCheck = checkNumber;
  }

  if (hints.applicantName) {
    const parts = hints.applicantName.trim().split(/\s+/);
    if (parts.length === 1) {
      updates.firstName = parts[0];
    } else if (parts.length === 2) {
      updates.firstName = parts[0];
      updates.lastName = parts[1];
    } else {
      updates.firstName = parts[0];
      updates.middleName = parts.slice(1, -1).join(" ");
      updates.lastName = parts[parts.length - 1];
    }
  }

  const facilityLabel = resolveFacilityLabelFromHints(hints);
  const facilitySearchName = facilityLabel.name;
  const facilityAddressParts = facilityLabel.address
    ? parseUsAddress(facilityLabel.address)
    : { address: "", city: "", state: "", zip: "" };

  const facilityMatch = findFacilityMatch(facilitySearchName, facilityList);
  if (hints.facilityId) {
    updates.facility = String(hints.facilityId);
    updates.facilityName =
      facilitySearchName ||
      hints.facilityName ||
      getFacilityLabel(facilityMatch);
    meta.facilityName = updates.facilityName;
    meta.facilityCreated = Boolean(hints.facilityCreated);
    meta.facilityReactivated = Boolean(hints.facilityReactivated);
    meta.facilityProfileIncomplete = Boolean(hints.facilityProfileIncomplete);
  } else if (facilityMatch) {
    updates.facility = String(facilityMatch.id);
    updates.facilityName = getFacilityLabel(facilityMatch);
    meta.facilityName = updates.facilityName;
  } else if (facilitySearchName) {
    updates.facilityName = facilitySearchName;
    meta.pendingFacilityName = facilitySearchName;
  }

  if (facilityAddressParts.address || facilityAddressParts.city) {
    meta.facilityAddress = facilityAddressParts.address || facilityLabel.address;
    meta.facilityCity = facilityAddressParts.city || "";
    meta.facilityState = facilityAddressParts.state || "";
    meta.facilityZip = sanitizeZip(facilityAddressParts.zip || "");
  }

  if (hints.missingDefaultDoctor) {
    meta.missingDefaultDoctor = true;
    meta.doctorCreated = Boolean(hints.doctorCreated);
  } else if (hints.specificDoctor) {
    updates.specificDoctor = hints.specificDoctor;
    updates.specificDoctorIsDefault = Boolean(hints.specificDoctorIsDefault);
    meta.doctorCreated = Boolean(hints.doctorCreated);
    meta.missingDefaultDoctor = false;
  }

  const providerSplit = splitNameAndAddress(hints.companyName || "");
  const providerName = providerSplit.name || hints.companyName;
  const companyAddressSource =
    providerSplit.address && looksLikeAddressSegment(providerSplit.address)
      ? providerSplit.address
      : hints.companyAddress || providerSplit.address || "";

  if (hints.providerId) {
    const matched =
      providerList.find((provider) => String(provider.id) === String(hints.providerId)) ||
      null;

    updates.providerId = String(hints.providerId);
    updates.serveCompanyName =
      providerName || getProviderLabel(matched) || updates.serveCompanyName || "";

    if (matched) {
      updates.address = matched.address || updates.address || "";
      updates.zip = sanitizeZip(matched.zipCode || matched.zip || updates.zip || "");
      updates.city = matched.city || updates.city || "";
      updates.state = matched.state || updates.state || "";
      updates.phone = matched.phone || updates.phone || "";
      updates.fax = matched.fax || updates.fax || "";
      updates.email =
        matched.email || hints.providerEmail || updates.email || "";
    } else {
      updates.email = hints.providerEmail || updates.email || "";
      if (companyAddressSource) {
        applyParsedServeAddress(updates, companyAddressSource);
      }
    }

    meta.providerName = updates.serveCompanyName;
    meta.providerCreated = Boolean(hints.providerCreated);
  } else if (providerName) {
    const providerMatch = findProviderMatch(providerName, providerList);
    if (providerMatch) {
      updates.providerId = String(providerMatch.id);
      updates.serveCompanyName = getProviderLabel(providerMatch);
      updates.address = providerMatch.address || updates.address || "";
      updates.zip = sanitizeZip(providerMatch.zipCode || providerMatch.zip || "");
      updates.city = providerMatch.city || "";
      updates.state = providerMatch.state || "";
      updates.phone = providerMatch.phone || "";
      updates.fax = providerMatch.fax || "";
      updates.email = providerMatch.email || "";
      meta.providerName = getProviderLabel(providerMatch);
    } else {
      updates.serveCompanyName = providerName;
      if (companyAddressSource) {
        applyParsedServeAddress(updates, companyAddressSource);
      }
    }
  } else if (companyAddressSource) {
    applyParsedServeAddress(updates, companyAddressSource);
  }

  fillMissingServeAddressParts(updates);

  const recordText = `${hints.recordType || ""} ${hints.requestedRecord || ""}`;
  const mappedType = mapRecordTypeToOrderType(
    hints.recordType,
    hints.requestedRecord
  );

  if (mappedType) {
    updates.type = mappedType;
    if (mappedType === "other") {
      updates.otherRecord = true;
    } else {
      updates[RECORD_FLAG_MAP[mappedType]] = true;
    }
  } else if (recordText.trim()) {
    updates.type = "other";
    updates.otherRecord = true;
  }

  applyRecordFlags(updates, recordText);

  const typeOrder = ["medical", "billing", "employment", "xrays", "other"];
  const firstSelectedType = typeOrder.find((type) => {
    if (type === "other") return updates.otherRecord;
    return updates[RECORD_FLAG_MAP[type]];
  });
  if (firstSelectedType) {
    updates.type = firstSelectedType;
  }

  return { updates, meta };
}

export function buildFormFromExtract(
  extract,
  { facilityList = [], providerList = [] } = {},
  subpoenaFile
) {
  const orderHints = {
    ...(extract?.orderHints || {}),
    ...(extract?.dateOfInjury && !extract?.orderHints?.dateOfInjury
      ? { dateOfInjury: extract.dateOfInjury }
      : {}),
    ...(extract?.providerId != null
      ? { providerId: String(extract.providerId) }
      : {}),
    ...(extract?.providerCreated != null
      ? { providerCreated: extract.providerCreated }
      : {}),
    ...(extract?.facilityId != null
      ? { facilityId: String(extract.facilityId) }
      : {}),
    ...(extract?.facilityName
      ? { facilityName: extract.facilityName }
      : {}),
    ...(extract?.facilityCreated != null
      ? { facilityCreated: extract.facilityCreated }
      : {}),
    ...(extract?.facilityReactivated != null
      ? { facilityReactivated: extract.facilityReactivated }
      : {}),
    ...(extract?.facilityProfileIncomplete != null
      ? { facilityProfileIncomplete: extract.facilityProfileIncomplete }
      : {}),
    ...(extract?.extractedDoctorName
      ? { extractedDoctorName: extract.extractedDoctorName }
      : {}),
    ...(extract?.specificDoctor ? { specificDoctor: extract.specificDoctor } : {}),
    ...(extract?.specificDoctorIsDefault != null
      ? { specificDoctorIsDefault: extract.specificDoctorIsDefault }
      : {}),
    ...(extract?.doctorCreated != null ? { doctorCreated: extract.doctorCreated } : {}),
    ...(extract?.missingDefaultDoctor != null
      ? { missingDefaultDoctor: extract.missingDefaultDoctor }
      : {}),
  };
  const { updates, meta } = mapOrderHintsToForm(orderHints, {
    facilityList,
    providerList,
  });

  return {
    formUpdates: {
      ...updates,
      ...(subpoenaFile ? { subpoenaFile } : {}),
      ...(extract?.id || extract?.extractId
        ? { subpoenaExtractId: String(extract.id || extract.extractId) }
        : {}),
    },
    meta,
  };
}
