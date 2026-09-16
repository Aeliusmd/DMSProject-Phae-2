export const ROLES = {
  ADMIN: "Admin",
  MANAGER: "Manager",
  EMPLOYEE: "Employee",
};

const EMPLOYEE_ALLOWED_PATH_PREFIXES = [
  "/dashboard",
  "/orders",
  "/company-orders",
  "/personal-orders",
  "/facilities",
  "/activity-log",
  "/notifications",
  "/tagged-notes",
  "/settings",
];

const MANAGER_BLOCKED_REPORT_PATHS = ["/reports/activity-report"];

export function normalizeRole(role) {
  return String(role || "").trim().toLowerCase();
}

export function isAdmin(user) {
  return normalizeRole(user?.role) === "admin";
}

export function isManager(user) {
  return normalizeRole(user?.role) === "manager";
}

export function isEmployee(user) {
  return normalizeRole(user?.role) === "employee";
}

export function isAdminOrManager(user) {
  const role = normalizeRole(user?.role);
  return role === "admin" || role === "manager";
}

export function canManageEmployees(user) {
  return isAdmin(user);
}

export function canAccessEmployeesPage(user) {
  return isAdmin(user) || isManager(user);
}

export function canDeleteFacilities(user) {
  return !isEmployee(user);
}

export function usesOwnActivityLogsOnly(user) {
  return isEmployee(user) || isManager(user);
}

export function canEmployeeAccessPath(pathname) {
  const path = String(pathname || "").split("?")[0];

  return EMPLOYEE_ALLOWED_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
}

export function canManagerAccessPath(pathname) {
  const path = String(pathname || "").split("?")[0];

  if (canEmployeeAccessPath(path)) {
    return true;
  }

  if (path === "/employees" || path.startsWith("/employees/")) {
    return true;
  }

  if (path === "/reports" || path.startsWith("/reports/")) {
    return !MANAGER_BLOCKED_REPORT_PATHS.some(
      (blocked) => path === blocked || path.startsWith(`${blocked}/`)
    );
  }

  return false;
}

export function canAccessRoute(user, pathname) {
  if (isAdmin(user)) {
    return true;
  }

  if (isManager(user)) {
    return canManagerAccessPath(pathname);
  }

  if (isEmployee(user)) {
    return canEmployeeAccessPath(pathname);
  }

  return true;
}

export function canAccessNavItem(user, href) {
  if (href === "/employees") {
    return canAccessEmployeesPage(user);
  }

  return canAccessRoute(user, href);
}

export function canAccessActivityReport(user) {
  return isAdmin(user);
}

export function getRestrictedRedirectPath(user) {
  if (isManager(user) || isEmployee(user)) {
    return "/orders";
  }

  return "/dashboard";
}

// Backward-compatible alias
export function getEmployeeRedirectPath() {
  return "/orders";
}
