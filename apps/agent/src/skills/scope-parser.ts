export function parseScope(
  scope: string | undefined,
): { brand?: string; series?: string } {
  if (!scope || scope === "global") return {};

  const result: { brand?: string; series?: string } = {};
  const parts = scope.split("/");

  for (const part of parts) {
    const [key, value] = part.split(":");
    if (key === "brand" && value) result.brand = value;
    if (key === "series" && value) result.series = value;
  }

  return result;
}
