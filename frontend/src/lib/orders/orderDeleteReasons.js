import { validateNoHtmlMarkup } from "@/lib/validations/nameValidation";

export const DELETE_REASON_OTHER = "Other";

export const PREDEFINED_DELETE_REASONS = [
  "Duplicate Order",
  "Incorrect Order Information",
  DELETE_REASON_OTHER,
];

export function isOtherDeleteReason(selectedReason) {
  return selectedReason === DELETE_REASON_OTHER;
}

export function resolveDeleteReason(selectedReason, customReason = "") {
  if (isOtherDeleteReason(selectedReason)) {
    return customReason.trim();
  }
  return selectedReason;
}

export function validateDeleteReasonSelection(selectedReason, customReason = "") {
  const errors = {};

  if (!selectedReason) {
    errors.selectedReason = "Please select a deletion reason.";
    return errors;
  }

  if (isOtherDeleteReason(selectedReason)) {
    const trimmedCustomReason = customReason.trim();
    if (!trimmedCustomReason) {
      errors.customReason = "Please enter a deletion reason.";
      return errors;
    }

    const markupError = validateNoHtmlMarkup(trimmedCustomReason, {
      fieldLabel: "Deletion reason",
    });
    if (markupError) {
      errors.customReason = markupError;
    }
  }

  return errors;
}
