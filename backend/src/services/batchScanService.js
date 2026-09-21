const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const ApiError = require("../utils/ApiError");
const fileStorage = require("../utils/fileStorage");
const { getPdfPageCount, extractPageRange } = require("../utils/pdfSplit");
const {
  mapSchemaToExtractRow,
  mapSchemaToOrderHints,
  resolveExtractionSchema,
  enrichOrderHintsFromRow,
} = require("../utils/extractionMapper");
const subpoenaExtractionService = require("./subpoenaExtractionService");
const { resolveProviderFromHints } = require("./providerService");
const { resolveFacilityFromHints, resolveDoctorFromExtractHints } = require("./facilityService");
const Facility = require("../models/Facility");
const { splitNameAndAddress } = require("../utils/addressParseUtils");
const { resolveBatchFacilityMismatch } = require("../utils/facilityNameUtils");
const batchScanRepository = require("../repositories/batchScanRepository");
const { withTransaction } = require("../config/database");

const MIME_PDF = "application/pdf";

function resolveCustomerFacilityName(customer = "") {
  const split = splitNameAndAddress(customer);
  return split.name || `${customer || ""}`.trim();
}

function buildDocumentId() {
  return randomUUID().replace(/-/g, "");
}

function buildBatchReference(documentId) {
  return `BATCH-${documentId.slice(0, 12).toUpperCase()}`;
}

function buildChildReference(documentId, index) {
  return `SUB-${documentId.slice(0, 12).toUpperCase()}-${String(index).padStart(3, "0")}`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function formatUploadDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const yy = String(date.getFullYear()).slice(-2);
  const hours = date.getHours();
  const mins = String(date.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";
  const h12 = hours % 12 || 12;
  return `${mm}/${dd}/${yy} ${h12}:${mins} ${ampm}`;
}

async function mapExtractRowToApi(row) {
  const confidence =
    typeof row.extraction_confidence === "string"
      ? JSON.parse(row.extraction_confidence || "{}")
      : row.extraction_confidence || {};
  const rawExtraction =
    typeof row.raw_extraction === "string"
      ? JSON.parse(row.raw_extraction || "{}")
      : row.raw_extraction || {};
  const schema = resolveExtractionSchema(rawExtraction);
  let orderHints = enrichOrderHintsFromRow(mapSchemaToOrderHints(schema), row);

  let providerResolution = { provider: null, created: false };
  if (orderHints.companyName) {
    providerResolution = await resolveProviderFromHints(orderHints);
    orderHints = providerResolution.orderHints;
  }

  let facilityResolution = { facility: null, created: false, reactivated: false };
  if (orderHints.customer) {
    facilityResolution = await resolveFacilityFromHints(orderHints);
    if (facilityResolution.facility) {
      const customerName = resolveCustomerFacilityName(orderHints.customer);

      orderHints = {
        ...orderHints,
        facilityId: facilityResolution.facility.id,
        facilityName:
          facilityResolution.facility.facilityName || customerName,
        facilityCreated: facilityResolution.created,
        facilityReactivated: Boolean(facilityResolution.reactivated),
        facilityProfileIncomplete: Boolean(
          facilityResolution.facility.isProfileIncomplete
        ),
      };
    }
  }

  let doctorResolution = {
    doctorName: "",
    created: false,
    usedDefault: false,
    missingDefault: false,
    extractedDoctorName: `${orderHints.specificDoctor || ""}`.trim(),
  };
  if (facilityResolution.facility?.id) {
    doctorResolution = await resolveDoctorFromExtractHints(
      facilityResolution.facility.id,
      orderHints
    );
    orderHints = {
      ...orderHints,
      extractedDoctorName: doctorResolution.extractedDoctorName,
      doctorCreated: Boolean(doctorResolution.created),
      missingDefaultDoctor: Boolean(doctorResolution.missingDefault),
      ...(doctorResolution.doctorName
        ? {
            specificDoctor: doctorResolution.doctorName,
            specificDoctorIsDefault: Boolean(doctorResolution.usedDefault),
          }
        : {
            specificDoctorIsDefault: false,
          }),
    };
  }

  return {
    id: row.id,
    parentId: row.parent_id,
    referenceCode: row.reference_code,
    subpoenaIndex: row.subpoena_index,
    fileName: row.file_name,
    storagePath: row.storage_path,
    pageCount: row.page_count,
    size: formatBytes(row.file_size_bytes),
    fileSizeBytes: row.file_size_bytes,
    uploadedAt: formatUploadDate(row.uploaded_at || row.created_at),
    isProcessed: Boolean(row.is_processed),
    orderHints,
    facilityId: facilityResolution.facility?.id || null,
    facilityName:
      facilityResolution.facility?.facilityName ||
      resolveCustomerFacilityName(orderHints.customer) ||
      null,
    facilityCreated: facilityResolution.created,
    facilityReactivated: Boolean(facilityResolution.reactivated),
    facilityProfileIncomplete: Boolean(
      facilityResolution.facility?.isProfileIncomplete
    ),
    extractedDoctorName: doctorResolution.extractedDoctorName || null,
    specificDoctor: doctorResolution.doctorName || null,
    specificDoctorIsDefault: Boolean(doctorResolution.usedDefault),
    doctorCreated: doctorResolution.created,
    missingDefaultDoctor: Boolean(doctorResolution.missingDefault),
    providerId: providerResolution.provider?.id || null,
    providerCreated: providerResolution.created,
    providerName: providerResolution.provider?.companyName || null,
    dateOfInjury: orderHints.dateOfInjury || null,
    extractionConfidence: confidence,
    batchReferenceCode: row.batch_reference_code,
    batchFileName: row.batch_file_name,
    batchStoragePath: row.batch_storage_path,
    pageRange: {
      start: row.page_range_start,
      end: row.page_range_end,
    },
    applicantName: row.applicant_name,
    caseName: row.case_name,
    orderNumber: row.order_number,
  };
}

function resolveFacilityMismatch(
  chosenFacilityId,
  extractedFacilityId,
  chosenFacilityName,
  extractedFacilityName
) {
  return resolveBatchFacilityMismatch({
    chosenFacilityId,
    extractedFacilityId,
    chosenFacilityName,
    extractedFacilityName,
  });
}

async function resolveExtractedFacilityMeta(orderHints = {}) {
  const fromCustomer = splitNameAndAddress(orderHints.customer || "");
  const fallbackName =
    `${fromCustomer.name || orderHints.customer || ""}`.trim();

  if (!orderHints.customer) {
    return {
      extractedFacilityId: null,
      extractedFacilityName: "",
      facilityReactivated: false,
    };
  }

  try {
    const { facility, reactivated } = await resolveFacilityFromHints(
      orderHints,
      null,
      {
        allowCreate: true,
      }
    );
    const extractedFacilityName =
      facility?.facilityName ||
      facility?.facility_name ||
      fallbackName;

    return {
      extractedFacilityId: facility?.id ? Number(facility.id) : null,
      extractedFacilityName: `${extractedFacilityName}`.trim(),
      facilityReactivated: Boolean(reactivated),
    };
  } catch (error) {
    // Never block extract persistence / new-order autofill on facility create.
    return {
      extractedFacilityId: null,
      extractedFacilityName: fallbackName,
      facilityReactivated: false,
    };
  }
}

async function processBatchScan(file, uploadedBy, options = {}) {
  if (!file?.buffer?.length) {
    throw new ApiError(400, "No file uploaded");
  }

  const userId = Number(uploadedBy);
  if (!userId) {
    throw new ApiError(400, "uploadedBy is required (matrix employee id)");
  }

  const employee = await batchScanRepository.findEmployeeById(userId);
  if (!employee) {
    throw new ApiError(400, "Invalid uploadedBy — employee not found or terminated");
  }

  // Facility dropdown applies to Batch Scan only. New Order single-subpoena
  // upload resolves facility from extraction / the order form instead.
  const requireChosenFacility = !options.singleSubpoena;
  const chosenFacilityId = Number(options.chosenFacilityId) || null;
  if (requireChosenFacility && !chosenFacilityId) {
    throw new ApiError(400, "Facility selection is required");
  }

  let chosenFacility = null;
  if (chosenFacilityId) {
    chosenFacility = await Facility.findById(chosenFacilityId);
    if (!chosenFacility) {
      throw new ApiError(400, "Selected facility does not exist");
    }
  }

  const originalName = file.originalname || "batch.pdf";
  if (path.extname(originalName).toLowerCase() !== ".pdf") {
    throw new ApiError(400, "Only PDF files are supported");
  }

  const documentId = buildDocumentId();
  const stem = fileStorage.sanitizeFileStem(originalName);
  const parentFileName = `${stem}_${userId}_${documentId}.pdf`;

  const extraction = await subpoenaExtractionService.processDocument(
    file.buffer,
    originalName
  );

  const results = Array.isArray(extraction.results) ? extraction.results : [];
  if (results.length === 0) {
    throw new ApiError(502, "Extraction service returned no subpoena results");
  }

  if (options.maxChildren && results.length > options.maxChildren) {
    throw new ApiError(
      400,
      `This PDF contains ${results.length} subpoenas. Use Orders → Batch Scan for multi-subpoena uploads.`
    );
  }

  const parentPageCount = await getPdfPageCount(file.buffer);
  const parentFile = fileStorage.saveBatchScanFile(
    userId,
    parentFileName,
    file.buffer
  );

  const preparedChildren = [];

  for (let idx = 0; idx < results.length; idx += 1) {
    const result = results[idx];
    const subpoenaIndex = result.subpoena_index ?? idx + 1;
    const pageRange = result.page_range || { start: 0, end: parentPageCount - 1 };
    const start = pageRange.start ?? 0;
    const end = pageRange.end ?? start;

    const childBuffer = await extractPageRange(file.buffer, start, end);
    const childFileName = `${documentId}_${subpoenaIndex}.pdf`;
    const childFile = fileStorage.saveBatchScanFile(
      userId,
      childFileName,
      childBuffer
    );
    const childPageCount = await getPdfPageCount(childBuffer);
    const schema = result.schema_extraction || {};
    const mapped = mapSchemaToExtractRow(schema);
    const orderHints = enrichOrderHintsFromRow(mapSchemaToOrderHints(schema), mapped);
    const { extractedFacilityId, extractedFacilityName, facilityReactivated } =
      await resolveExtractedFacilityMeta(orderHints);
    if (extractedFacilityId) {
      orderHints.facilityId = String(extractedFacilityId);
      orderHints.facilityName = extractedFacilityName;
      orderHints.facilityReactivated = Boolean(facilityReactivated);
      orderHints.facilityCreated = false;
    }
    const facilityMismatch = chosenFacilityId
      ? resolveFacilityMismatch(
          chosenFacilityId,
          extractedFacilityId,
          chosenFacility?.facility_name || "",
          extractedFacilityName
        )
      : false;

    preparedChildren.push({
      reference_code: buildChildReference(documentId, subpoenaIndex),
      subpoena_index: subpoenaIndex,
      file_name: childFile.fileName,
      storage_path: childFile.relativePath,
      mime_type: MIME_PDF,
      file_size_bytes: childBuffer.length,
      page_count: childPageCount,
      page_range_start: start,
      page_range_end: end,
      ...mapped,
      order_hints: orderHints,
      extracted_facility_id: extractedFacilityId,
      facility_mismatch: facilityMismatch,
      facility_reactivated: Boolean(facilityReactivated),
    });
  }

  const parentReference = buildBatchReference(documentId);

  const dbResult = await withTransaction(async (conn) => {
    const parentId = await batchScanRepository.insertParentBatch(conn, {
      reference_code: parentReference,
      file_name: parentFile.fileName,
      storage_path: parentFile.relativePath,
      mime_type: MIME_PDF,
      file_size_bytes: file.buffer.length,
      page_count: parentPageCount,
      uploaded_by: userId,
      chosen_facility_id: chosenFacilityId,
    });

    const childIds = [];
    for (const child of preparedChildren) {
      const childId = await batchScanRepository.insertChildExtract(conn, {
        parent_id: parentId,
        reference_code: child.reference_code,
        subpoena_index: child.subpoena_index,
        file_name: child.file_name,
        storage_path: child.storage_path,
        mime_type: child.mime_type,
        file_size_bytes: child.file_size_bytes,
        page_count: child.page_count,
        page_range_start: child.page_range_start,
        page_range_end: child.page_range_end,
        applicant_name: child.applicant_name,
        case_name: child.case_name,
        order_number: child.order_number,
        ssn: child.ssn,
        date_of_birth: child.date_of_birth,
        date_of_injury: child.date_of_injury,
        customer: child.customer,
        company_name: child.company_name,
        company_address: child.company_address,
        specific_doctor: child.specific_doctor,
        doctor_address: child.doctor_address,
        record_type: child.record_type,
        requested_record: child.requested_record,
        subpoena_date: child.subpoena_date,
        date_requested: child.date_requested,
        depo_due_date: child.depo_due_date,
        amount: child.amount,
        cheque_date: child.cheque_date,
        cheque_number: child.cheque_number,
        extraction_confidence: child.extraction_confidence,
        raw_extraction: child.raw_extraction,
        extracted_facility_id: child.extracted_facility_id,
        facility_mismatch: child.facility_mismatch,
      });
      childIds.push(childId);
    }

    await batchScanRepository.insertActivityLog(conn, {
      action: options.singleSubpoena ? "Single Subpoena Uploaded" : "Batch Scan Uploaded",
      module: "Processing",
      performed_by: userId,
      performer_name: employee.name,
      details: options.singleSubpoena
        ? `Single subpoena ${parentReference}: ${originalName} → ${parentFile.relativePath}`
        : `Batch ${parentReference}: ${originalName} → ${preparedChildren.length} subpoena(s). Parent: ${parentFile.relativePath}`,
    });

    return { parentId, childIds };
  });

  let autoCreate = { created: [], failed: [] };
  if (!options.singleSubpoena && dbResult.childIds.length) {
    const orderService = require("./orderService");
    autoCreate = await orderService.autoCreateOrdersFromBatch({
      childIds: dbResult.childIds,
      actorId: userId,
      chosenFacilityId,
    });
  }

  const children = preparedChildren.map((child, index) => ({
    id: dbResult.childIds[index],
    parentId: dbResult.parentId,
    referenceCode: child.reference_code,
    subpoenaIndex: child.subpoena_index,
    fileName: child.file_name,
    storagePath: child.storage_path,
    pageCount: child.page_count,
    fileSizeBytes: child.file_size_bytes,
    pageRange: {
      start: child.page_range_start,
      end: child.page_range_end,
    },
    orderHints: child.order_hints,
    extractedFacilityId: child.extracted_facility_id || null,
    facilityMismatch: Boolean(child.facility_mismatch),
    facilityReactivated: Boolean(child.facility_reactivated),
    extractionConfidence: child.extraction_confidence,
  }));

  return {
    documentId,
    chosenFacilityId,
    chosenFacilityName: chosenFacility?.facility_name || null,
    parent: {
      id: dbResult.parentId,
      referenceCode: parentReference,
      fileName: parentFile.fileName,
      storagePath: parentFile.relativePath,
      pageCount: parentPageCount,
      fileSizeBytes: file.buffer.length,
      uploadedBy: userId,
      uploadedByName: employee.name,
    },
    total: children.length,
    isMulti: Boolean(extraction.is_multi),
    autoCreate,
    children,
  };
}

async function getUnprocessedQueue() {
  const rows = await batchScanRepository.listUnprocessedExtracts();
  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    referenceCode: row.reference_code,
    subpoenaIndex: row.subpoena_index,
    fileName: row.file_name,
    uploadedAt: formatUploadDate(row.uploaded_at),
    pages: row.page_count,
    size: formatBytes(row.file_size_bytes),
    applicantName: row.applicant_name,
    caseName: row.case_name,
    orderNumber: row.order_number,
    batchReferenceCode: row.batch_reference_code,
    batchFileName: row.batch_file_name,
  }));
}

async function getUnprocessedExtract(extractId) {
  const row = await batchScanRepository.getExtractById(extractId);
  if (!row || row.is_processed) {
    throw new ApiError(404, "Unprocessed subpoena not found");
  }
  return await mapExtractRowToApi(row);
}

async function getUnprocessedExtractFile(extractId) {
  const row = await batchScanRepository.getExtractById(extractId);
  if (!row || row.is_processed) {
    throw new ApiError(404, "Unprocessed subpoena not found");
  }

  const absolutePath = fileStorage.resolveAbsolutePath(row.storage_path);
  if (!fs.existsSync(absolutePath)) {
    throw new ApiError(
      404,
      "This subpoena PDF could not be opened. The file may have been moved or deleted."
    );
  }

  return {
    absolutePath,
    fileName: row.file_name || "subpoena.pdf",
  };
}

async function processSingleSubpoena(file, uploadedBy) {
  const result = await processBatchScan(file, uploadedBy, {
    maxChildren: 1,
    singleSubpoena: true,
  });

  const child = result.children[0];
  if (!child?.id) {
    throw new ApiError(500, "Failed to save subpoena extract");
  }

  const extract = await getUnprocessedExtract(child.id);
  const facilityReactivated = Boolean(child.facilityReactivated);

  return {
    extractId: child.id,
    parentId: result.parent.id,
    extract: {
      ...extract,
      facilityReactivated,
      facilityCreated: facilityReactivated ? false : extract.facilityCreated,
      orderHints: {
        ...(extract.orderHints || {}),
        facilityReactivated,
        ...(facilityReactivated
          ? { facilityCreated: false }
          : {}),
      },
    },
    orderHints: {
      ...(extract.orderHints || {}),
      facilityReactivated,
    },
    fileName: child.fileName,
    storagePath: child.storagePath,
  };
}

module.exports = {
  processBatchScan,
  processSingleSubpoena,
  getUnprocessedQueue,
  getUnprocessedExtract,
  getUnprocessedExtractFile,
  mapExtractRowToApi,
};
