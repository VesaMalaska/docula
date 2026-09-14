export const GENERIC_UPLOAD_ERROR_MESSAGE = "Image upload failed. Please try again.";
export const INVALID_IMAGE_ERROR_MESSAGE = "Please upload a valid image file (JPEG, PNG, GIF, WebP).";
export const FILE_TOO_LARGE_ERROR_MESSAGE = "Image must be under 5MB.";

export interface UserSafeUploadError {
  title: string;
  message: string;
}

/**
 * Maps upload errors and validation failures to user-safe presentation messages.
 * Prevents raw internal configuration, AWS, Firebase, authorization, network,
 * or SDK details from being exposed to the user.
 */
export function classifyUploadError(error: unknown): UserSafeUploadError {
  const code =
    typeof error === "string"
      ? error
      : error instanceof Error || (error && typeof error === "object" && "message" in error)
      ? String((error as { message?: unknown }).message)
      : "";

  if (
    code === "UNSUPPORTED_IMAGE_TYPE" ||
    code === "NOT_AN_IMAGE" ||
    code === "Failed to load image" ||
    code === "Unsupported file type" ||
    code === "Unsupported source file type" ||
    code === INVALID_IMAGE_ERROR_MESSAGE
  ) {
    return {
      title: "Invalid Image",
      message: INVALID_IMAGE_ERROR_MESSAGE,
    };
  }

  if (
    code === "FILE_TOO_LARGE" ||
    code === "File too large" ||
    code === FILE_TOO_LARGE_ERROR_MESSAGE
  ) {
    return {
      title: "File too large",
      message: FILE_TOO_LARGE_ERROR_MESSAGE,
    };
  }

  // All unexpected configuration, server, AWS, Firebase, authorization, network, and SDK errors
  // map to the generic user-safe message without exposing internal details.
  return {
    title: "Upload Failed",
    message: GENERIC_UPLOAD_ERROR_MESSAGE,
  };
}

/**
 * Client-side upload error handler that presents safe error dialogs.
 * Ensures that neither user-facing alerts nor client-side console output
 * expose internal error details, configuration strings, bucket names,
 * object keys, credentials, tokens, or signatures.
 */
export function handleClientUploadError(
  error: unknown,
  showAlert: (title: string, message: string) => void
): UserSafeUploadError {
  const safeError = classifyUploadError(error);
  showAlert(safeError.title, safeError.message);
  // Redundant client-side console logging is omitted entirely because the user
  // already receives a safe dialog, and omitting it guarantees no unexpected
  // error details, credentials, tokens, or configuration names can reach the browser console.
  return safeError;
}
