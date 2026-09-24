const express = require("express");
const invoiceController = require("../controllers/invoiceController");
const { authenticate } = require("../middleware/authMiddleware");

const router = express.Router();

router.use(authenticate);

router.get("/", invoiceController.getAll);
router.get("/company-wise", invoiceController.getCompanyWise);
router.get("/company-wise/:companyId", invoiceController.getByCompany);
router.post(
  "/order/:orderId/edit-lock",
  invoiceController.acquireInvoiceEditLock
);
router.post(
  "/order/:orderId/edit-lock/heartbeat",
  invoiceController.heartbeatInvoiceEditLock
);
router.delete(
  "/order/:orderId/edit-lock",
  invoiceController.releaseInvoiceEditLock
);
router.get("/xray/order/:orderId", invoiceController.getXrayByOrder);
router.post("/xray/send", invoiceController.sendXray);
router.post("/xray/resend", invoiceController.resendXray);
router.post("/xray", invoiceController.createXray);
router.post("/send", invoiceController.send);
router.post("/resend", invoiceController.resend);
router.post("/order/:orderId/email", invoiceController.emailByOrder);
router.post("/xray/order/:orderId/email", invoiceController.emailXrayByOrder);
router.post("/write-off", invoiceController.writeOff);
router.get("/:id", invoiceController.getById);
router.post("/", invoiceController.create);
router.put("/:id", invoiceController.update);

module.exports = router;
