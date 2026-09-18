/**
 * Model layer — data access and database schemas.
 */

module.exports = {
  Employee: require("./Employee"),
  AuthSession: require("./AuthSession"),
  Facility: require("./Facility"),
  OfficeManager: require("./OfficeManager"),
  FacilityDoctor: require("./FacilityDoctor"),
  Provider: require("./Provider"),
  Order: require("./Order"),
  Patient: require("./Patient"),
  FacilityDocument: require("./FacilityDocument"),
  FacilityNote: require("./FacilityNote"),
  FacilityNoteAttachment: require("./FacilityNoteAttachment"),
  EmployeeSettings: require("./EmployeeSettings"),
  ActivityLog: require("./ActivityLog"),
};
