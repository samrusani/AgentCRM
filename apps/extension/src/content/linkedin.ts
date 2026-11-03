import { extractLinkedinProfile, isProfilePath } from '../extract/linkedin';
import { compact } from '../extract/common';
import { startChip } from './chip';

startChip({
  isProfile: (url) => isProfilePath(url.pathname) !== null,
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
    });
  },
});
