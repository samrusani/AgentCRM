import { api } from '../../src/api/client';
import { addedMessage, removedMessage, withNextStep } from '../../src/lib/lists';

describe('addedMessage', () => {
  it('counts added people and the ones already on the list', () => {
    expect(addedMessage({ added: 3, already: 0 }, 'UK Angels')).toBe('Added 3 people to UK Angels.');
    expect(addedMessage({ added: 1, already: 0 }, 'UK Angels')).toBe('Added 1 person to UK Angels.');
    expect(addedMessage({ added: 3, already: 2 }, 'UK Angels')).toBe('Added 3 people to UK Angels. 2 were already on it.');
    expect(addedMessage({ added: 2, already: 1 }, 'UK Angels')).toBe('Added 2 people to UK Angels. 1 was already on it.');
  });

  it('says so when nobody new was added', () => {
    expect(addedMessage({ added: 0, already: 1 }, 'UK Angels')).toBe('That person was already on UK Angels.');
    expect(addedMessage({ added: 0, already: 4 }, 'UK Angels')).toBe('All 4 people were already on UK Angels.');
  });
});

describe('removedMessage', () => {
  it('reports a full or partial removal', () => {
    expect(removedMessage(2, 2, 'UK Angels')).toBe('Removed 2 people from UK Angels.');
    expect(removedMessage(1, 3, 'UK Angels')).toBe('Removed 1 of 3 people from UK Angels. 2 could not be removed and stay selected. Try again.');
  });
});

describe('withNextStep', () => {
  it('adds a final period when the server message has none, then the next step', () => {
    expect(withNextStep(new Error('Name is required'), 'Try again.')).toBe('Name is required. Try again.');
    expect(withNextStep(new Error('Name is required.'), 'Try again.')).toBe('Name is required. Try again.');
  });
});

describe('api.lists.addMembers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('splits more than 500 people into calls of at most 500 and adds the counts up', async () => {
    const bodies: string[][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const ids = (JSON.parse(String(init?.body)) as { personIds: string[] }).personIds;
        bodies.push(ids);
        return new Response(JSON.stringify({ added: ids.length - 1, already: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    const ids = Array.from({ length: 501 }, (_, index) => `per-${index}`);
    const result = await api.lists.addMembers('lst-1', ids);
    expect(bodies.map((body) => body.length)).toEqual([500, 1]);
    expect(result).toEqual({ added: 499, already: 2 });
  });
});
