const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const { throwIfInvalid } = require("../utils/validationUtils");
const {
  validateCreateFacility,
  validateUpdateFacility,
  validateResolveFacility,
  validateResolveDoctor,
  validateCreateDoctors,
  validateUpdateDoctor,
} = require("../validators/facilityValidator");
const { validateSearchQuery, validatePositiveIntRouteParam } = require("../validators/queryValidators");
const facilityService = require("../services/facilityService");
const facilityEditLockService = require("../services/facilityEditLockService");
const activityLogService = require("../services/activityLogService");
const notificationService = require("../services/notificationService");

function formatManagerName(manager) {
  return (
    [manager.firstName, manager.middleName, manager.lastName]
      .filter(Boolean)
      .join(" ")
      .trim() || "Unknown"
  );
}

function buildFacilityLogBase(req, facility) {
  return {
    facilityId: facility.id,
    companyName: facility.facilityName,
    targetEmployeeId: req.user?.id,
  };
}

async function logOfficeManagerChanges(req, before, after) {
  const base = buildFacilityLogBase(req, after);
  const beforeIds = new Set((before?.officeManagers || []).map((manager) => manager.id));
  const afterIds = new Set((after?.officeManagers || []).map((manager) => manager.id));

  for (const manager of after.officeManagers || []) {
    if (!beforeIds.has(manager.id)) {
      const managerName = formatManagerName(manager);

      await activityLogService.recordFromRequest(req, {
        ...base,
        context: "facilities",
        action: "add_office_manager",
        details: `Added office manager ${managerName} to ${after.facilityName}`,
      });

      await notificationService.notifyFacilityEvent({
        title: "Office Manager Added",
        description: `${managerName} added to ${after.facilityName}`,
        facilityId: after.id,
      });
    }
  }

  for (const manager of before?.officeManagers || []) {
    if (!afterIds.has(manager.id)) {
      const managerName = formatManagerName(manager);

      await activityLogService.recordFromRequest(req, {
        ...base,
        context: "facilities",
        action: "remove_office_manager",
        details: `Removed office manager ${managerName} from ${after.facilityName}`,
      });

      await notificationService.notifyFacilityEvent({
        title: "Office Manager Removed",
        description: `${managerName} removed from ${after.facilityName}`,
        facilityId: after.id,
      });
    }
  }
}

exports.getAll = asyncHandler(async (req, res) => {
  const result = await facilityService.getAllFacilities(req.query);
  if (Array.isArray(result)) {
    return ApiResponse.success(res, { facilities: result });
  }
  return ApiResponse.success(res, result);
});

exports.search = asyncHandler(async (req, res) => {
  throwIfInvalid(validateSearchQuery(req.query));
  const facilities = await facilityService.searchFacilities(req.query.q);
  return ApiResponse.success(res, { facilities });
});

exports.resolve = asyncHandler(async (req, res) => {
  throwIfInvalid(validateResolveFacility(req.body));
  const { facility, created, reactivated } =
    await facilityService.resolveFacilityByName(req.body);
  return ApiResponse.success(res, {
    facility,
    created,
    reactivated: Boolean(reactivated),
  });
});

exports.getById = asyncHandler(async (req, res) => {
  const facility = await facilityService.getFacilityById(req.params.id);
  return ApiResponse.success(res, { facility });
});

exports.acquireEditLock = asyncHandler(async (req, res) => {
  const lock = await facilityEditLockService.acquireFacilityEditLock(
    req.params.id,
    req.user.id
  );
  return ApiResponse.success(res, { lock }, "Facility edit lock acquired");
});

exports.heartbeatEditLock = asyncHandler(async (req, res) => {
  const lock = await facilityEditLockService.heartbeatFacilityEditLock(
    req.params.id,
    req.user.id
  );
  return ApiResponse.success(res, { lock }, "Facility edit lock refreshed");
});

exports.releaseEditLock = asyncHandler(async (req, res) => {
  const result = await facilityEditLockService.releaseFacilityEditLock(
    req.params.id,
    req.user.id
  );
  return ApiResponse.success(res, result, "Facility edit lock released");
});

exports.create = asyncHandler(async (req, res) => {
  throwIfInvalid(validateCreateFacility(req.body));
  const facility = await facilityService.createFacility(req.body);
  const logBase = buildFacilityLogBase(req, facility);

  await activityLogService.recordFromRequest(req, {
    ...logBase,
    context: "facilities",
    action: "create",
    details: `Created facility ${facility.facilityName}`,
  });

  await notificationService.notifyFacilityEvent({
    title: "Facility Created",
    description: `New facility ${facility.facilityName} was added`,
    facilityId: facility.id,
  });

  await logOfficeManagerChanges(req, { officeManagers: [] }, facility);

  return ApiResponse.created(res, { facility }, "Facility created successfully");
});

exports.update = asyncHandler(async (req, res) => {
  throwIfInvalid(validateUpdateFacility(req.body));
  await facilityEditLockService.assertNotLockedByOther(
    req.params.id,
    req.user.id
  );
  const before = await facilityService.getFacilityById(req.params.id);
  const facility = await facilityService.updateFacility(
    req.params.id,
    req.body,
    req.user.id
  );
  const logBase = buildFacilityLogBase(req, facility);

  await activityLogService.recordFromRequest(req, {
    ...logBase,
    context: "facilities",
    action: "update",
    details: `Updated facility ${facility.facilityName}`,
  });

  await notificationService.notifyFacilityEvent({
    title: "Facility Updated",
    description: `${facility.facilityName} was updated`,
    facilityId: facility.id,
  });

  await logOfficeManagerChanges(req, before, facility);

  return ApiResponse.success(res, { facility }, "Facility updated successfully");
});

exports.remove = asyncHandler(async (req, res) => {
  const result = await facilityService.deleteFacility(req.params.id);

  if (result.deleted) {
    const facility = {
      id: result.id,
      facilityName: result.facilityName,
    };

    await activityLogService.recordFromRequest(req, {
      ...buildFacilityLogBase(req, facility),
      context: "facilities",
      action: "delete",
      details: `Deleted facility ${facility.facilityName || req.params.id}`,
    });

    await notificationService.notifyFacilityEvent({
      title: "Facility Deleted",
      description: `${facility.facilityName || "Facility"} was removed`,
      facilityId: facility.id || Number(req.params.id),
    });
  }

  return ApiResponse.success(res, result, result.message);
});

exports.resolveDoctor = asyncHandler(async (req, res) => {
  throwIfInvalid(validatePositiveIntRouteParam(req.params.id, "id"));
  throwIfInvalid(validateResolveDoctor(req.body || {}));

  const result = await facilityService.resolveFacilityDoctor(
    req.params.id,
    req.body || {}
  );

  return ApiResponse.success(res, result);
});

exports.createDoctors = asyncHandler(async (req, res) => {
  throwIfInvalid(validateCreateDoctors(req.body));
  await facilityEditLockService.assertNotLockedByOther(
    req.params.id,
    req.user.id
  );
  const facility = await facilityService.getFacilityById(req.params.id);
  const doctors = await facilityService.createDoctors(
    req.params.id,
    req.body.doctors || []
  );

  await activityLogService.recordFromRequest(req, {
    ...buildFacilityLogBase(req, facility),
    context: "facilities",
    action: "create_doctors",
    details: `Added ${doctors.length} doctor(s) to ${facility.facilityName}`,
  });

  await notificationService.notifyFacilityEvent({
    title: "Doctors Added",
    description: `${doctors.length} doctor(s) added to ${facility.facilityName}`,
    facilityId: facility.id,
  });

  return ApiResponse.created(res, { doctors }, "Doctors created successfully");
});

exports.updateDoctor = asyncHandler(async (req, res) => {
  throwIfInvalid(validateUpdateDoctor(req.body || {}));
  await facilityEditLockService.assertNotLockedByOther(
    req.params.id,
    req.user.id
  );
  const facility = await facilityService.getFacilityById(req.params.id);
  const doctor = await facilityService.updateDoctor(
    req.params.id,
    req.params.doctorId,
    req.body || {}
  );

  await activityLogService.recordFromRequest(req, {
    ...buildFacilityLogBase(req, facility),
    context: "facilities",
    action: "update_doctor",
    details: `Updated doctor ${doctor.doctor} at ${facility.facilityName}`,
  });

  await notificationService.notifyFacilityEvent({
    title: "Doctor Updated",
    description: `${doctor.doctor} was updated at ${facility.facilityName}`,
    facilityId: facility.id,
  });

  return ApiResponse.success(res, { doctor }, "Doctor updated successfully");
});

exports.deactivateDoctor = asyncHandler(async (req, res) => {
  await facilityEditLockService.assertNotLockedByOther(
    req.params.id,
    req.user.id
  );
  const facility = await facilityService.getFacilityById(req.params.id);
  const doctor = await facilityService.deactivateDoctor(
    req.params.id,
    req.params.doctorId
  );

  await activityLogService.recordFromRequest(req, {
    ...buildFacilityLogBase(req, facility),
    context: "facilities",
    action: "deactivate_doctor",
    details: `Deactivated doctor ${doctor.doctor} at ${facility.facilityName}`,
  });

  await notificationService.notifyFacilityEvent({
    title: "Doctor Deactivated",
    description: `${doctor.doctor} deactivated at ${facility.facilityName}`,
    facilityId: facility.id,
  });

  return ApiResponse.success(res, { doctor }, "Doctor deactivated successfully");
});

exports.reactivateDoctor = asyncHandler(async (req, res) => {
  await facilityEditLockService.assertNotLockedByOther(
    req.params.id,
    req.user.id
  );
  const facility = await facilityService.getFacilityById(req.params.id);
  const doctor = await facilityService.reactivateDoctor(
    req.params.id,
    req.params.doctorId
  );

  await activityLogService.recordFromRequest(req, {
    ...buildFacilityLogBase(req, facility),
    context: "facilities",
    action: "reactivate_doctor",
    details: `Re-activated doctor ${doctor.doctor} at ${facility.facilityName}`,
  });

  await notificationService.notifyFacilityEvent({
    title: "Doctor Reactivated",
    description: `${doctor.doctor} reactivated at ${facility.facilityName}`,
    facilityId: facility.id,
  });

  return ApiResponse.success(res, { doctor }, "Doctor reactivated successfully");
});

exports.setDefaultDoctor = asyncHandler(async (req, res) => {
  await facilityEditLockService.assertNotLockedByOther(
    req.params.id,
    req.user.id
  );
  const facility = await facilityService.getFacilityById(req.params.id);
  const doctor = await facilityService.setDefaultDoctor(
    req.params.id,
    req.params.doctorId
  );

  await activityLogService.recordFromRequest(req, {
    ...buildFacilityLogBase(req, facility),
    context: "facilities",
    action: "set_default_doctor",
    details: `Set ${doctor.doctor} as default doctor at ${facility.facilityName}`,
  });

  await notificationService.notifyFacilityEvent({
    title: "Default Doctor Updated",
    description: `${doctor.doctor} set as default at ${facility.facilityName}`,
    facilityId: facility.id,
  });

  return ApiResponse.success(res, { doctor }, "Default doctor updated");
});
