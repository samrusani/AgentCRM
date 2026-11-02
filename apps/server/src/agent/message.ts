import type { Db } from '../db.js';
import { searchAll } from '../queries/search.js';
import { getCounts } from '../queries/workspace.js';

export interface AgentAction {
  id: string;
  label: string;
  kind: 'start_demo_run' | 'open_record';
  entityType?: 'person' | 'organization' | 'opportunity';
  entityId?: string;
}

export interface AgentReply {
  reply: string;
  actions: AgentAction[];
  modelConnected: false;
}

const noModel = 'No model connected. Runs are simulated until you add one.';

const startRunAction: AgentAction = {
  id: 'start_demo_run',
  label: 'Start simulated research run',
  kind: 'start_demo_run',
};

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

export function respondToMessage(db: Db, workspaceId: string, text: string): AgentReply {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();

  if (greeting.test(normalized) && normalized.split(' ').length <= 4) {
    return {
      reply: `Hello. ${noModel} I follow a few fixed rules, so I can start a simulated research run, answer record counts, or open a record when you give me a name.`,
      actions: [startRunAction],
      modelConnected: false,
    };
  }

  if (helpIntent.test(normalized)) {
    return {
      reply: `${noModel} This is a rule based helper, not a model. It can start a simulated research run, answer record counts such as "how many people", and open a record by name.`,
      actions: [startRunAction],
      modelConnected: false,
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
      modelConnected: false,
    };
  }

  if (researchVerb.test(normalized) && researchNoun.test(normalized)) {
    return {
      reply: `${noModel} I can start a simulated research run. It follows a script, adds synthetic candidates tagged demo-candidate, and asks you to approve a shortlist. It does not search the web.`,
      actions: [startRunAction],
      modelConnected: false,
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
        modelConnected: false,
      };
    }
  }

  return {
    reply: `${noModel} I could not match that request to anything I can do. Try "find investors", "how many people", or the name of a record.`,
    actions: [startRunAction],
    modelConnected: false,
  };
}
