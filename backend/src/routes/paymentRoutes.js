const express = require("express");
const paymentController = require("../controllers/paymentController");
const { authenticate } = require("../middleware/authMiddleware");

const router = express.Router();

router.use(authenticate);

router.get("/manual", paymentController.getManualPayments);
router.get("/online", paymentController.getOnlinePayments);
router.get("/orders/invoices/search", paymentController.searchOrderInvoices);
router.post(
  "/orders/:orderId/edit-lock",
  paymentController.acquireManualPaymentLock
);
router.post(
  "/orders/:orderId/edit-lock/heartbeat",
  paymentController.heartbeatManualPaymentLock
);
router.delete(
  "/orders/:orderId/edit-lock",
  paymentController.releaseManualPaymentLock
);
router.get("/orders/:orderId/detail", paymentController.getOrderPaymentDetail);
router.get(
  "/orders/:orderId/company-portal-wallet-receipt",
  paymentController.downloadCompanyPortalWalletReceipt
);
router.post("/manual", paymentController.recordManualPayment);

module.exports = router;
