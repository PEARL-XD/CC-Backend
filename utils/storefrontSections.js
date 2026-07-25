function normalizeSectionKey(category) {
  return String(category || "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "");
}

export function isCookedCategory(category) {
  return normalizeSectionKey(category) === "cooked";
}

export function isReadyToEatCategory(category) {
  const normalized = normalizeSectionKey(category);
  return normalized === "readytoeat" || normalized === "rte";
}

export function isSectionDisabledForCategory(category, settings = {}) {
  if (isCookedCategory(category)) {
    return settings.cookedEnabled === false;
  }

  if (isReadyToEatCategory(category)) {
    return settings.readyToEatEnabled === false;
  }

  return false;
}

export function getSectionDisabledReason(category) {
  if (isCookedCategory(category)) {
    return "Cooked section is not available right now.";
  }

  if (isReadyToEatCategory(category)) {
    return "Ready-to-eat section is not available right now.";
  }

  return "Section is not available right now.";
}
