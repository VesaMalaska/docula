export interface SpaceNameValidationResult {
  isValid: boolean;
  error?: string;
  trimmedName: string;
}

export function validateSpaceName(name: string): SpaceNameValidationResult {
  const trimmedName = name ? name.trim() : "";
  if (trimmedName.length === 0) {
    return {
      isValid: false,
      error: "Space name cannot be empty.",
      trimmedName: "",
    };
  }
  return {
    isValid: true,
    trimmedName,
  };
}
