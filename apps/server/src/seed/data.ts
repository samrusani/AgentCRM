// Every name here is invented. Domains use example.com and example.org only.
export const firstNames = [
  'Maren', 'Tobias', 'Ilsa', 'Cormac', 'Perrin', 'Odalys', 'Junius', 'Linnea', 'Basil', 'Soren',
  'Wynn', 'Calla', 'Ezra', 'Rhea', 'Anselm', 'Tamsin', 'Idris', 'Odette', 'Lucan', 'Merrin',
  'Hollis', 'Zora', 'Casimir', 'Nell', 'Orrin', 'Petra', 'Silas', 'Thea', 'Ulric', 'Vesper',
  'Wilder', 'Xenia', 'Yara', 'Zane', 'Aurelia', 'Bram', 'Delphine', 'Emrys', 'Faye', 'Gideon',
];

export const lastNames = [
  'Ashlowe', 'Brindlemoor', 'Caldermere', 'Dunmarrow', 'Eskerfield', 'Fenwhistle', 'Gravenor', 'Hollowell',
  'Ironbrook', 'Juniperre', 'Kestrelby', 'Lowenthorpe', 'Marrowgate', 'Netherby', 'Oakhallow', 'Pemberlane',
  'Quillfeather', 'Ravenscombe', 'Saltmarsh', 'Thistlewood', 'Umberfield', 'Valecrest', 'Wrenfield', 'Yarrowby',
  'Zephyrine', 'Armitrel', 'Bexmoor', 'Corvindale', 'Draymoor', 'Elderwick', 'Farnsworthy', 'Glenhaven',
  'Harrowmere', 'Inglethorp', 'Jessamy', 'Kirkbarrow', 'Larkspur', 'Mossgrove', 'Northcrofte', 'Orchardson',
  'Pellinore', 'Quenby', 'Rookwood', 'Stonemarch', 'Tarnbury', 'Ulverstan', 'Vexley', 'Wintermere',
  'Xanderby', 'Yewdale', 'Zinnowick', 'Aldermoor', 'Blackmoor', 'Crestfall', 'Dovecott', 'Emberly',
  'Foxglade', 'Gildersleeve', 'Hawkridge', 'Ivywell',
];

export interface OrganizationSeed {
  name: string;
  kind: 'fund' | 'company';
  slug: string;
  location: string;
  focus: string;
}

export const organizations: OrganizationSeed[] = [
  { name: 'Lanternrow Capital', kind: 'fund', slug: 'lanternrow', location: 'Austin', focus: 'Seed, climate and energy' },
  { name: 'Kestrel Hollow Ventures', kind: 'fund', slug: 'kestrelhollow', location: 'Lisbon', focus: 'Pre-seed, developer tools' },
  { name: 'Brindle Point Partners', kind: 'fund', slug: 'brindlepoint', location: 'Toronto', focus: 'Seed, fintech' },
  { name: 'Ostrander Quay Fund', kind: 'fund', slug: 'ostranderquay', location: 'Singapore', focus: 'Series A, logistics' },
  { name: 'Tamarack Lane Capital', kind: 'fund', slug: 'tamaracklane', location: 'Denver', focus: 'Seed, health technology' },
  { name: 'Fallowmere Ventures', kind: 'fund', slug: 'fallowmere', location: 'Dublin', focus: 'Seed, enterprise software' },
  { name: 'Copperwick Partners', kind: 'fund', slug: 'copperwick', location: 'Berlin', focus: 'Series A, industrial software' },
  { name: 'Halcyon Reach Capital', kind: 'fund', slug: 'halcyonreach', location: 'Melbourne', focus: 'Seed, consumer' },
  { name: 'Quillon Ridge Ventures', kind: 'fund', slug: 'quillonridge', location: 'Nairobi', focus: 'Pre-seed, emerging markets' },
  { name: 'Sablewood Capital', kind: 'fund', slug: 'sablewood', location: 'Austin', focus: 'Seed, data infrastructure' },
  { name: 'Thornfield Gate Partners', kind: 'fund', slug: 'thornfieldgate', location: 'Toronto', focus: 'Series A, security' },
  { name: 'Umbral Bay Fund', kind: 'fund', slug: 'umbralbay', location: 'Lisbon', focus: 'Seed, education technology' },
  { name: 'Vireo Lane Capital', kind: 'fund', slug: 'vireolane', location: 'Denver', focus: 'Seed, food and agriculture' },
  { name: 'Wickerby Ventures', kind: 'fund', slug: 'wickerby', location: 'Dublin', focus: 'Pre-seed, open source' },
  { name: 'Yellowfen Partners', kind: 'fund', slug: 'yellowfen', location: 'Singapore', focus: 'Series A, marketplaces' },
  { name: 'Zarrow Pier Capital', kind: 'fund', slug: 'zarrowpier', location: 'Melbourne', focus: 'Seed, climate and energy' },
  { name: 'Pocketloom Labs', kind: 'company', slug: 'pocketloom', location: 'Austin', focus: 'Mobile tooling' },
  { name: 'Driftwell Software', kind: 'company', slug: 'driftwell', location: 'Lisbon', focus: 'Workflow software' },
  { name: 'Ledgerleaf', kind: 'company', slug: 'ledgerleaf', location: 'Toronto', focus: 'Small business accounting' },
  { name: 'Bramblecart', kind: 'company', slug: 'bramblecart', location: 'Denver', focus: 'Grocery delivery' },
  { name: 'Quartzfold', kind: 'company', slug: 'quartzfold', location: 'Berlin', focus: 'Materials analytics' },
  { name: 'Plumbline Health', kind: 'company', slug: 'plumblinehealth', location: 'Melbourne', focus: 'Clinic scheduling' },
  { name: 'Gristmill Data', kind: 'company', slug: 'gristmilldata', location: 'Dublin', focus: 'Data pipelines' },
  { name: 'Fernhollow Foods', kind: 'company', slug: 'fernhollow', location: 'Nairobi', focus: 'Packaged foods' },
  { name: 'Oddwick Logistics', kind: 'company', slug: 'oddwick', location: 'Singapore', focus: 'Freight software' },
  { name: 'Cindergate Energy', kind: 'company', slug: 'cindergate', location: 'Denver', focus: 'Grid storage' },
  { name: 'Mintlark Learning', kind: 'company', slug: 'mintlark', location: 'Lisbon', focus: 'Online tutoring' },
  { name: 'Sparrowpost', kind: 'company', slug: 'sparrowpost', location: 'Toronto', focus: 'Shipping labels' },
  { name: 'Hexwhorl Systems', kind: 'company', slug: 'hexwhorl', location: 'Berlin', focus: 'Industrial sensors' },
  { name: 'Loamwright', kind: 'company', slug: 'loamwright', location: 'Austin', focus: 'Soil monitoring' },
];

export const fundTitles = ['Managing partner', 'General partner', 'Partner', 'Principal', 'Associate', 'Venture partner', 'Scout'];
export const companyTitles = ['Chief executive officer', 'Chief financial officer', 'Head of partnerships', 'Founder', 'Chief operating officer'];

export const personTags = ['seed', 'series-a', 'angel', 'climate', 'fintech', 'health', 'warm-intro', 'repeat-founder'];

export const owners = ['Jordan Quill', 'Casey Marlow', 'Riley Fenwick'];

export const noteTemplates = [
  'Intro call booked for next week.',
  'Sent the deck. Waiting on feedback.',
  'Asked about check size and timeline.',
  'Partner meeting is scheduled.',
  'Shared the data room link.',
  'Asked for two customer references.',
  'Mentioned a conflict with an existing portfolio company.',
  'Follow up after the board meeting.',
  'Positive first call. Wants to see the financial model.',
  'Requested an updated cap table.',
];

export const taskTemplates = [
  'Send updated deck to {name}',
  'Follow up with {name}',
  'Prepare diligence folder for {name}',
  'Book partner meeting with {name}',
  'Share the financial model with {name}',
  'Send two customer references to {name}',
  'Confirm timeline with {name}',
  'Review term sheet notes from {name}',
  'Check in with {name} after the board meeting',
  'Draft intro request for {name}',
  'Update the cap table for {name}',
  'Schedule a product demo for {name}',
  'Send a thank you note to {name}',
  'Ask {name} for a warm introduction',
  'Archive the closed notes for {name}',
];

export const passReasons = ['Fund does not invest at this stage.', 'Outside the fund focus.'];
export const lostReason = 'The fund closed its round with another lead.';
export const nurtureReasons = ['Revisit after next quarter.', 'Wants to see more traction first.'];
