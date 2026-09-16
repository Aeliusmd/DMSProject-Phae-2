const orderNoteTagService = require("../services/orderNoteTagService");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");

exports.getTaggableStaff = asyncHandler(async (req, res) => {
  const staff = await orderNoteTagService.getTaggableStaff({
    search: req.query.search || "",
  });
  return ApiResponse.success(res, { staff });
});

exports.getInbox = asyncHandler(async (req, res) => {
  const result = await orderNoteTagService.getTaggedNotesInbox(req.user.id, {
    limit: req.query.limit,
    offset: req.query.offset,
    timezone: req.clientTimezone,
  });
  return ApiResponse.success(res, result);
});

exports.getUnreadCount = asyncHandler(async (req, res) => {
  const result = await orderNoteTagService.getTaggedNotesUnreadCount(req.user.id);
  return ApiResponse.success(res, result);
});

exports.markAsRead = asyncHandler(async (req, res) => {
  const result = await orderNoteTagService.markTaggedNoteAsRead(
    req.params.id,
    req.user.id
  );
  return ApiResponse.success(res, result, "Tagged note marked as read");
});

exports.markAllAsRead = asyncHandler(async (req, res) => {
  const result = await orderNoteTagService.markAllTaggedNotesAsRead(req.user.id);
  return ApiResponse.success(res, result, "All tagged notes marked as read");
});
