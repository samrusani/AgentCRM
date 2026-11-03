import type { Criterion, QualificationConfig } from './qualification/config.js';

export interface WorkspaceTemplate {
  id: string;
  name: string;
  description: string;
  pipelineName: string;
  stageNames: readonly string[];
  defaultQualificationConfig: () => QualificationConfig;
}

const doNotContact = (id: string): Criterion => ({
  id,
  label: 'Tagged do not contact',
  target: 'person',
  field: 'tags',
  operator: 'contains',
  values: ['do-not-contact'],
  enabled: true,
});

function startupQualification(): QualificationConfig {
  return {
    exclusions: [doNotContact('excl-do-not-contact')],
    criteria: [
      {
        id: 'crit-org-fund',
        label: 'Organization is a fund',
        target: 'organization',
        field: 'kind',
        operator: 'equals',
        values: ['fund'],
        enabled: true,
      },
      {
        id: 'crit-title-investing-role',
        label: 'Title is partner, principal, scout, or head of',
        target: 'person',
        field: 'title',
        operator: 'contains',
        values: ['partner', 'principal', 'scout', 'head of'],
        enabled: true,
      },
      {
        id: 'crit-tag-seed',
        label: 'Tagged seed',
        target: 'person',
        field: 'tags',
        operator: 'contains',
        values: ['seed'],
        enabled: true,
      },
    ],
  };
}

function fundLpQualification(): QualificationConfig {
  return {
    exclusions: [doNotContact('lp-excl-do-not-contact')],
    criteria: [
      {
        id: 'lp-crit-org-fund',
        label: 'Organization is a fund',
        target: 'organization',
        field: 'kind',
        operator: 'equals',
        values: ['fund'],
        enabled: true,
      },
      {
        id: 'lp-crit-title-allocator-role',
        label: 'Title is partner, principal, chief investment officer, head of, director, or family office',
        target: 'person',
        field: 'title',
        operator: 'contains',
        values: ['partner', 'principal', 'chief investment officer', 'head of', 'director', 'family office'],
        enabled: true,
      },
      {
        id: 'lp-crit-tag-lp',
        label: 'Tagged lp',
        target: 'person',
        field: 'tags',
        operator: 'contains',
        values: ['lp'],
        enabled: true,
      },
    ],
  };
}

function clientSalesQualification(): QualificationConfig {
  return {
    exclusions: [doNotContact('sales-excl-do-not-contact')],
    criteria: [
      {
        id: 'sales-crit-org-company',
        label: 'Organization is a company',
        target: 'organization',
        field: 'kind',
        operator: 'equals',
        values: ['company'],
        enabled: true,
      },
      {
        id: 'sales-crit-title-buyer-role',
        label: 'Title is founder, chief executive officer, chief operating officer, vp, head of, or director',
        target: 'person',
        field: 'title',
        operator: 'contains',
        values: ['founder', 'chief executive officer', 'chief operating officer', 'vp', 'head of', 'director'],
        enabled: true,
      },
      {
        id: 'sales-crit-tag-prospect',
        label: 'Tagged prospect',
        target: 'person',
        field: 'tags',
        operator: 'contains',
        values: ['prospect'],
        enabled: true,
      },
    ],
  };
}

export const defaultTemplate = 'startup-fundraising';

// The one registry of workspace templates. Records, tags, claims, tasks, and history never belong to a template.
export const templates: readonly WorkspaceTemplate[] = [
  {
    id: 'startup-fundraising',
    name: 'Startup fundraising',
    description: 'Raise a round from funds and angels, from first research to a closed round.',
    pipelineName: 'Fundraising',
    stageNames: ['Research', 'Qualified', 'Introduction or outreach', 'Meeting', 'Diligence', 'Commitment', 'Closed'],
    defaultQualificationConfig: startupQualification,
  },
  {
    id: 'fund-lp',
    name: 'Fund LP fundraising',
    description: 'Raise capital for a fund from limited partners, family offices, and other allocators.',
    pipelineName: 'LP fundraising',
    stageNames: ['Research', 'Qualified', 'Introduction or outreach', 'Meeting', 'Due diligence', 'Soft commitment', 'Subscribed'],
    defaultQualificationConfig: fundLpQualification,
  },
  {
    id: 'client-sales',
    name: 'Client sales',
    description: 'Win clients by finding buyers at companies and moving them from outreach to a signed deal.',
    pipelineName: 'Sales',
    stageNames: ['Research', 'Qualified', 'Outreach', 'Discovery', 'Proposal', 'Negotiation', 'Closed'],
    defaultQualificationConfig: clientSalesQualification,
  },
];

export function getTemplate(id: string): WorkspaceTemplate | undefined {
  return templates.find((template) => template.id === id);
}

export function requireTemplate(id: string): WorkspaceTemplate {
  const template = getTemplate(id);
  if (!template) throw new Error(`Unknown template "${id}".`);
  return template;
}
