const express = require("express");
const orderNoteTagController = require("../controllers/orderNoteTagController");
const { authenticate, authorize } = require("../middleware/authMiddleware");

const router = express.Router();

router.use(authenticate);

router.get(
  "/taggable-staff",
  authorize("Admin"),
  orderNoteTagController.getTaggableStaff
);

router.get(
  "/inbox",
  authorize("Admin", "Manager", "Employee"),
  orderNoteTagController.getInbox
);

router.get(
  "/unread-count",
  authorize("Admin", "Manager", "Employee"),
  orderNoteTagController.getUnreadCount
);

router.patch(
  "/read-all",
  authorize("Admin", "Manager", "Employee"),
  orderNoteTagController.markAllAsRead
);

router.patch(
  "/:id/read",
  authorize("Admin", "Manager", "Employee"),
  orderNoteTagController.markAsRead
);

module.exports = router;
