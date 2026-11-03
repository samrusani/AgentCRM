import { extractLinkedinProfile, findLinkedinNameAnchor, isProfilePath } from '../extract/linkedin';
import { compact } from '../extract/common';
import { startChip } from './chip';

startChip({
  source: 'linkedin',
  findAnchor: (doc) => findLinkedinNameAnchor(doc, new URL(location.href)),
  profileKey: (url) => isProfilePath(url.pathname),
  build: (doc, url) => {
    const profile = extractLinkedinProfile(doc, url);
    return compact({
      source: 'linkedin' as const,
      url: url.origin + url.pathname,
      name: profile.name,
      headline: profile.headline,
      company: profile.company,
      location: profile.location,
      email: profile.email,
      phone: profile.phone,
      website: profile.website,
    });
  },
});
