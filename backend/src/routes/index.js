const express = require("express");

const authRoutes = require("./authRoutes");
const companyPortalAuthRoutes = require("./companyPortalAuthRoutes");
const companyPortalManagementRoutes = require("./companyPortalManagementRoutes");
const companyPortalOrderRoutes = require("./companyPortalOrderRoutes");
const personalPortalAuthRoutes = require("./personalPortalAuthRoutes");
const personalPortalRequestRoutes = require("./personalPortalRequestRoutes");
const orderRoutes = require("./orderRoutes");
const providerRoutes = require("./providerRoutes");
const facilityRoutes = require("./facilityRoutes");
const employeeRoutes = require("./employeeRoutes");
const invoiceRoutes = require("./invoiceRoutes");
const reportRoutes = require("./reportRoutes");
const notificationRoutes = require("./notificationRoutes");
const activityLogRoutes = require("./activityLogRoutes");
const settingsRoutes = require("./settingsRoutes");
const dashboardRoutes = require("./dashboardRoutes");
const paymentRoutes = require("./paymentRoutes");
const publicRoutes = require("./publicRoutes");
const companyOrdersRoutes = require("./companyOrdersRoutes");
const staffPersonalOrderRoutes = require("./staffPersonalOrderRoutes");
const orderNoteTagRoutes = require("./orderNoteTagRoutes");

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/company-portal/auth", companyPortalAuthRoutes);
router.use("/company-portal", companyPortalManagementRoutes);
router.use("/company-portal", companyPortalOrderRoutes);
router.use("/company-orders", companyOrdersRoutes);
router.use("/personal-portal/auth", personalPortalAuthRoutes);
router.use("/personal-portal", personalPortalRequestRoutes);
router.use("/orders", orderRoutes);
router.use("/personal-orders", staffPersonalOrderRoutes);
router.use("/order-note-tags", orderNoteTagRoutes);
router.use("/providers", providerRoutes);
router.use("/facilities", facilityRoutes);
router.use("/employees", employeeRoutes);
router.use("/invoices", invoiceRoutes);
router.use("/reports", reportRoutes);
router.use("/notifications", notificationRoutes);
router.use("/activity-log", activityLogRoutes);
router.use("/settings", settingsRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/payments", paymentRoutes);
router.use("/public", publicRoutes);

module.exports = router;
