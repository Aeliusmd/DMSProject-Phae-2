const express = require("express");
const facilityController = require("../controllers/facilityController");
const facilityDocumentController = require("../controllers/facilityDocumentController");
const facilityNoteController = require("../controllers/facilityNoteController");
const { authenticate } = require("../middleware/authMiddleware");
const { denyRoles } = require("../middleware/roleMiddleware");
const { facilityDocumentUpload, facilityNoteAttachmentUpload } = require("../middleware/uploadMiddleware");

const router = express.Router();

router.use(authenticate);

const employeeDeleteGuard = denyRoles("Employee");

router.get("/", facilityController.getAll);
router.get("/search", facilityController.search);
router.post("/resolve", facilityController.resolve);
router.post("/", facilityController.create);

router.get("/:id/documents", facilityDocumentController.listDocuments);
router.post(
  "/:id/documents",
  facilityDocumentUpload.single("file"),
  facilityDocumentController.uploadDocument
);
router.get(
  "/:id/documents/:documentId/download",
  facilityDocumentController.downloadDocument
);
router.get(
  "/:id/documents/:documentId/preview",
  facilityDocumentController.previewDocument
);
router.delete(
  "/:id/documents/:documentId",
  facilityDocumentController.deleteDocument
);

router.get("/:id/notes", facilityNoteController.listNotes);
router.post(
  "/:id/notes",
  facilityNoteAttachmentUpload.array("attachments", 10),
  facilityNoteController.createNote
);
router.get(
  "/:id/notes/:noteId/attachments/:attachmentId/download",
  facilityNoteController.downloadAttachment
);

router.post("/:id/edit-lock", facilityController.acquireEditLock);
router.post("/:id/edit-lock/heartbeat", facilityController.heartbeatEditLock);
router.delete("/:id/edit-lock", facilityController.releaseEditLock);

router.get("/:id", facilityController.getById);
router.put("/:id", facilityController.update);
router.delete("/:id", employeeDeleteGuard, facilityController.remove);

router.post("/:id/doctors/resolve", facilityController.resolveDoctor);
router.post("/:id/doctors", facilityController.createDoctors);
router.put("/:id/doctors/:doctorId", facilityController.updateDoctor);
router.patch(
  "/:id/doctors/:doctorId/deactivate",
  facilityController.deactivateDoctor
);
router.patch(
  "/:id/doctors/:doctorId/reactivate",
  facilityController.reactivateDoctor
);
router.patch(
  "/:id/doctors/:doctorId/default",
  facilityController.setDefaultDoctor
);

module.exports = router;
