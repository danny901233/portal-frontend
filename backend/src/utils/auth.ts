export const resolveAllowedGarages = (
  payload?: { garageIds?: string[]; garageId?: string }
): string[] => {
  if (!payload) {
    return [];
  }
  const { garageIds, garageId } = payload;
  if (Array.isArray(garageIds) && garageIds.length > 0) {
    return garageIds;
  }
  if (typeof garageId === 'string' && garageId.trim()) {
    return [garageId.trim()];
  }
  return [];
};
