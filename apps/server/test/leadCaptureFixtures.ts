// Fictional engagement and profile items shaped like the harvestapi actors' output.

export const postUrl = 'https://www.linkedin.com/posts/example-person_topic-activity-7100000000000000001-AbCd?utm_source=share';

export const reactionsActorId = 'harvestapi~linkedin-post-reactions';
export const commentsActorId = 'harvestapi~linkedin-post-comments';
export const profileActorId = 'harvestapi~linkedin-profile-scraper';

export const reactionItems = [
  { reactionType: 'LIKE', actor: { name: 'Ada Quill', linkedinUrl: 'https://www.linkedin.com/in/ada-quill', position: 'Partner at Northwind Labs' } },
  { reactionType: 'INTEREST', actor: { name: 'Ben Marsh', linkedinUrl: 'https://www.linkedin.com/in/ben-marsh/?trk=feed', position: 'Principal' } },
  { reactionType: 'EMPATHY', actor: { name: 'Cara Voss', linkedinUrl: 'https://www.linkedin.com/in/cara-voss', position: 'Founder' } },
  { reactionType: 'LIKE', actor: { name: 'Dan Orr', linkedinUrl: 'https://www.linkedin.com/in/dan-orr', position: 'Analyst' } },
];

export const commentItems = [
  // Ada also commented, so she must merge into one row with her reaction.
  { commentary: 'Great point about early stage funds. '.repeat(10), actor: { name: 'Ada Quill', linkedinUrl: 'https://LinkedIn.com/in/ada-quill/', position: 'Partner' } },
  // The author shape is the fallback.
  { commentary: 'Thanks for sharing.', author: { name: 'Eve Stone', headline: 'Operator', profile_url: 'https://www.linkedin.com/in/eve-stone' } },
  { commentary: 'No profile at all.', actor: { name: 'Fay Nolan', position: 'Advisor' } },
  { commentary: 'Nothing that names a person.', actor: {} },
];

export const profileItems = [
  {
    firstName: 'Ben',
    lastName: 'Marsh',
    headline: 'Principal at Harbor Row',
    publicIdentifier: 'ben-marsh',
    linkedinUrl: 'https://www.linkedin.com/in/ben-marsh',
    location: { linkedinText: 'Port Alder, Aurelia' },
    currentPosition: [{ companyName: 'Harbor Row' }],
  },
  {
    firstName: 'Cara',
    lastName: 'Voss',
    headline: 'Founder and CEO',
    publicIdentifier: 'cara-voss',
    linkedinUrl: 'https://www.linkedin.com/in/cara-voss',
    location: { linkedinText: 'Lakemont, Aurelia' },
    currentPosition: [{ companyName: 'Voss Works' }],
  },
  // Flat shape with an email, to prove tolerant mapping. It matches Dan Orr by profile URL.
  {
    fullName: 'Dan Orr',
    headline: 'Analyst at Orr Capital',
    companyName: 'Orr Capital',
    email: 'dan.orr@orrcapital.example.com',
    linkedinUrl: 'https://www.linkedin.com/in/dan-orr',
  },
  // Matches nobody.
  { firstName: 'Zed', lastName: 'Nobody', publicIdentifier: 'zed-nobody', linkedinUrl: 'https://www.linkedin.com/in/zed-nobody' },
];
