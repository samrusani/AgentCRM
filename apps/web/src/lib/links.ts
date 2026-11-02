export function recordLink(entityType: string | null, entityId: string | null): string | null {
  if (!entityType || !entityId) return null;
  if (entityType === 'person') return `/relationships?tab=people&person=${entityId}`;
  if (entityType === 'organization') return `/relationships?tab=organizations&org=${entityId}`;
  if (entityType === 'opportunity') return `/pipeline?opportunity=${entityId}`;
  return null;
}
