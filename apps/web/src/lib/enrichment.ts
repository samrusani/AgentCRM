export const ENRICH_FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  location: 'Location',
  email: 'Email',
  linkedinUrl: 'LinkedIn',
  xUrl: 'X',
  website: 'Website',
  calendarUrl: 'Calendar',
  domain: 'Domain',
};

// Fields whose suggested value is a URL the user can open to check before accepting.
export const ENRICH_LINK_FIELDS: ReadonlySet<string> = new Set(['linkedinUrl', 'xUrl', 'website', 'calendarUrl']);
