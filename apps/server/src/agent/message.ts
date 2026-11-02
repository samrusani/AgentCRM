import type { Db } from '../db.js';
import { getConnector } from '../queries/connectors.js';
import { searchAll } from '../queries/search.js';
import { getCounts } from '../queries/workspace.js';

export interface AgentAction {
  id: string;
  label: string;
  kind: 'start_demo_run' | 'start_apify_import' | 'open_record';
  entityType?: 'person' | 'organization' | 'opportunity';
  entityId?: string;
}

export interface AgentReply {
  reply: string;
  actions: AgentAction[];
  modelConnected: boolean;
  // Set when a model is connected but its call failed, so the reply above is the rule based one.
  modelFailed?: true;
  usage?: AgentUsage;
  // Which provider and model answered, or would have answered if the call had not failed.
  provider?: string;
  model?: string;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

type Intent = 'greeting' | 'help' | 'scrape' | 'count' | 'research' | 'records' | 'unmatched';

interface RuleAnswer {
  reply: string;
  actions: AgentAction[];
  intent: Intent;
}

const defaultNoModel = 'No model connected. Runs are simulated until you add one.';

const startRunAction: AgentAction = {
  id: 'start_demo_run',
  label: 'Start simulated research run',
  kind: 'start_demo_run',
};

const startApifyImportAction: AgentAction = {
  id: 'start_apify_import',
  label: 'Set up an Apify import',
  kind: 'start_apify_import',
};

// Only explicit wording. "leads" alone is a research or record request, not a reason to open the import setup.
const scrapeIntent = /\b(scrape|scrapes|scraping|scraper|scrapers|apify|import|imports|importing)\b/;

const stopWords = new Set([
  'open', 'show', 'tell', 'about', 'who', 'what', 'whats', 'is', 'are', 'the', 'a', 'an', 'me', 'my', 'record', 'for',
  'of', 'on', 'please', 'can', 'you', 'to', 'see', 'view', 'look', 'up', 'pull', 'get', 'details', 'detail', 'info',
  'information', 'find', 'search', 'with', 'at', 'in', 'and', 'do', 'we', 'know',
]);

const greeting = /^(hi|hello|hey|hiya|yo|good (morning|afternoon|evening))\b/;
const helpIntent = /\b(help|what can you do|how does this work|what do you do)\b/;
const researchVerb = /\b(find|research|source|sourcing|discover|look for|search for|get me|build a list|shortlist|prospect|start|run)\b/;
const researchNoun = /\b(investor|investors|fund|funds|vc|vcs|angel|angels|lead|leads|prospects|candidate|candidates|research run|demo run|research)\b/;
const countIntent = /how many (people|contacts|organi[sz]ations|orgs|funds|companies|opportunities|deals|tasks|runs)/;

// Rule based answer. With a model connected, pass a note that says the model call failed so the reply
// does not claim that no model is connected.
export function respondToMessage(db: Db, workspaceId: string, text: string, modelNote?: string): AgentReply {
  const answer = answerByRules(db, workspaceId, text, modelNote ?? defaultNoModel);
  return {
    reply: answer.reply,
    actions: answer.actions,
    modelConnected: modelNote !== undefined,
    ...(modelNote !== undefined ? { modelFailed: true as const } : {}),
  };
}

// Suggested actions for a model backed reply. Only requests the rules recognise on purpose count, so a
// greeting or an unmatched question does not get a button.
export function suggestActions(db: Db, workspaceId: string, text: string): AgentAction[] {
  const answer = answerByRules(db, workspaceId, text, defaultNoModel);
  return answer.intent === 'scrape' || answer.intent === 'research' || answer.intent === 'records' ? answer.actions : [];
}

function answerByRules(db: Db, workspaceId: string, text: string, noModel: string): RuleAnswer {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();

  if (greeting.test(normalized) && normalized.split(' ').length <= 4) {
    return {
      reply: `Hello. ${noModel} I follow a few fixed rules, so I can start a simulated research run, answer record counts, or open a record when you give me a name.`,
      actions: [startRunAction],
      intent: 'greeting',
    };
  }

  if (helpIntent.test(normalized)) {
    return {
      reply: `${noModel} This is a rule based helper, not a model. It can start a simulated research run, answer record counts such as "how many people", and open a record by name.`,
      actions: [startRunAction],
      intent: 'help',
    };
  }

  if (scrapeIntent.test(normalized)) {
    const connector = getConnector(db, workspaceId, 'apify');
    if (connector && connector.status === 'connected') {
      return {
        reply: `${noModel} Apify is connected. I can open the import setup, where you pick an actor, check its input, and set an item limit. Nothing runs until you start it, and results wait for your review before anything enters the CRM.`,
        actions: [startApifyImportAction],
        intent: 'scrape',
      };
    }
    return {
      reply: `${noModel} Scraping needs Apify. Connect Apify in Settings with your API token, then ask again.`,
      actions: [],
      intent: 'scrape',
    };
  }

  const counts = getCounts(db, workspaceId);
  const countMatch = countIntent.exec(normalized);
  if (countMatch) {
    const subject = countMatch[1] ?? '';
    let value = counts.people;
    let label = 'people';
    if (/organi|orgs|funds|companies/.test(subject)) {
      value = counts.organizations;
      label = 'organizations';
    } else if (/opportunit|deals/.test(subject)) {
      value = counts.opportunities;
      label = 'opportunities';
    } else if (/tasks/.test(subject)) {
      value = counts.tasksOpen;
      label = 'open tasks';
    } else if (/runs/.test(subject)) {
      value = counts.runs;
      label = 'runs';
    }
    return {
      reply: `This workspace has ${value} ${label}. ${noModel}`,
      actions: [],
      intent: 'count',
    };
  }

  if (researchVerb.test(normalized) && researchNoun.test(normalized)) {
    return {
      reply: `${noModel} I can start a simulated research run. It follows a script, adds synthetic candidates tagged demo-candidate, and asks you to approve a shortlist. It does not search the web.`,
      actions: [startRunAction],
      intent: 'research',
    };
  }

  const terms = normalized
    .replace(/[^a-z0-9@.\-' ]/g, ' ')
    .split(' ')
    .filter((word) => word.length >= 2 && !stopWords.has(word));
  if (terms.length > 0) {
    const found = searchAll(db, workspaceId, terms.join(' '), 5);
    const matches = [...found.people, ...found.organizations, ...found.opportunities];
    if (matches.length === 0 && terms.length > 1) {
      for (const term of terms) {
        const partial = searchAll(db, workspaceId, term, 3);
        matches.push(...partial.people, ...partial.organizations, ...partial.opportunities);
      }
    }
    if (matches.length > 0) {
      const seen = new Set<string>();
      const actions: AgentAction[] = [];
      for (const match of matches) {
        if (seen.has(match.id) || actions.length >= 5) continue;
        seen.add(match.id);
        const entityType = match.id.startsWith('per_')
          ? 'person'
          : match.id.startsWith('org_')
            ? 'organization'
            : 'opportunity';
        actions.push({ id: `open_${match.id}`, label: `Open ${match.name}`, kind: 'open_record', entityType, entityId: match.id });
      }
      return {
        reply: `I found ${actions.length} matching ${actions.length === 1 ? 'record' : 'records'}. I can open ${actions.length === 1 ? 'it' : 'them'}, but I cannot analyze ${actions.length === 1 ? 'it' : 'them'}. ${noModel}`,
        actions,
        intent: 'records',
      };
    }
  }

  return {
    reply: `${noModel} I could not match that request to anything I can do. Try "find investors", "how many people", or the name of a record.`,
    actions: [startRunAction],
    intent: 'unmatched',
  };
}
