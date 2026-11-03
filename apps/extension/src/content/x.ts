import { extractXProfile, isProfileView } from '../extract/x';
import { compact } from '../extract/common';
import { startChip } from './chip';

startChip({
  isProfile: (url) => isProfileView(url.pathname) !== null,
  build: (doc, url) => {
    const profile = extractXProfile(doc, url);
    return compact({
      source: 'x' as const,
      url: url.origin + url.pathname,
      name: profile.name,
      handle: profile.handle,
      bio: profile.bio,
      location: profile.location,
      website: profile.website,
    });
  },
});
