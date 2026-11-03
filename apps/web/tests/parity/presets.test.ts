// @vitest-environment node
import { PROVIDERS } from '../../src/lib/models';
// The server catalog is the source of truth. This is a plain relative import out of the package: vitest compiles the
// server file itself, so the production build of the web app never sees it.
import {
  compatiblePresets,
  defaultModelId,
  offeredModelIds,
  providerCatalog,
  providerLabels,
  providerPricesAsOf,
} from '../../../server/src/providers/presets';
import { modelListPrices } from '../../../server/src/providers/anthropic';

type Keyed = 'anthropic' | 'openai' | 'deepseek' | 'zai';
const KEYED: Keyed[] = ['anthropic', 'openai', 'deepseek', 'zai'];

interface ServerPrice {
  input: number;
  output: number;
}

// One lookup for every keyed provider, so the checks below do not care that Anthropic prices live in a different table.
function serverPrices(kind: Keyed, id: string): ServerPrice | undefined {
  if (kind === 'anthropic') {
    const prices = (modelListPrices as Record<string, { inputPerMillionUsd: number; outputPerMillionUsd: number }>)[id];
    return prices ? { input: prices.inputPerMillionUsd, output: prices.outputPerMillionUsd } : undefined;
  }
  const model = compatiblePresets[kind].models.find((entry) => entry.id === id);
  return model ? { input: model.prices.inputPerMillionUsd, output: model.prices.outputPerMillionUsd } : undefined;
}

function webProvider(kind: string) {
  const provider = PROVIDERS.find((entry) => entry.kind === kind);
  if (!provider) throw new Error(`Preset drift: the web app has no provider "${kind}" that the server offers. Add it to apps/web/src/lib/models.ts.`);
  return provider;
}

describe('web model presets match the server catalog', () => {
  it('lists the same providers in the same order', () => {
    const server = providerCatalog().map((entry) => entry.kind);
    const web = PROVIDERS.map((entry) => entry.kind);
    expect(web, 'Preset drift: provider list or order differs between the web app and the server').toEqual(server);
  });

  it('shows Ollama as keyless with no preset models, like the server', () => {
    const web = webProvider('ollama');
    const server = providerCatalog().find((entry) => entry.kind === 'ollama');
    expect(web.keyed, 'Preset drift: provider ollama, field keyed').toBe(false);
    expect(web.models, 'Preset drift: provider ollama, field models (the server lists none because Ollama models come from the local server)').toEqual([]);
    expect(web.defaultModelId, 'Preset drift: provider ollama, field defaultModelId').toBeNull();
    expect(server?.defaultModel, 'Preset drift: provider ollama, server defaultModel').toBeNull();
    expect(server?.models, 'Preset drift: provider ollama, server models').toEqual([]);
  });

  describe.each(KEYED)('%s', (kind) => {
    it('has the same provider name', () => {
      expect(webProvider(kind).name, `Preset drift: provider ${kind}, field name`).toBe(providerLabels[kind]);
    });

    it('is keyed, like every non-local provider on the server', () => {
      expect(webProvider(kind).keyed, `Preset drift: provider ${kind}, field keyed`).toBe(true);
    });

    it('offers the same model ids in the same order', () => {
      const web = webProvider(kind).models.map((model) => model.id);
      expect(web, `Preset drift: provider ${kind}, field model ids (list or order)`).toEqual(offeredModelIds(kind));
    });

    it('has the same default model', () => {
      expect(webProvider(kind).defaultModelId, `Preset drift: provider ${kind}, field defaultModelId`).toBe(defaultModelId(kind));
    });

    it('has the same default model as the catalog the server sends to clients', () => {
      const entry = providerCatalog().find((item) => item.kind === kind);
      expect(webProvider(kind).defaultModelId, `Preset drift: provider ${kind}, field defaultModelId against providerCatalog`).toBe(entry?.defaultModel);
    });

    it('has the same input and output price for every model', () => {
      for (const model of webProvider(kind).models) {
        const server = serverPrices(kind, model.id);
        expect(server, `Preset drift: provider ${kind}, model ${model.id}, the server has no prices for it`).toBeDefined();
        expect(model.inputPerMillion, `Preset drift: provider ${kind}, model ${model.id}, field inputPerMillion`).toBe(server?.input);
        expect(model.outputPerMillion, `Preset drift: provider ${kind}, model ${model.id}, field outputPerMillion`).toBe(server?.output);
      }
    });

    it('prices the default model', () => {
      const id = webProvider(kind).defaultModelId;
      expect(webProvider(kind).models.some((model) => model.id === id), `Preset drift: provider ${kind}, defaultModelId ${id} is not in the web model list`).toBe(true);
    });
  });

  // The price qualifier is a capability the web exposes as copy: the server's `priceQualifier` ("peak" for DeepSeek)
  // must show up in the web model notes and price note, and must not show up for providers without one.
  describe.each(['openai', 'deepseek', 'zai'] as const)('price qualifier for %s', (kind) => {
    const qualifier = compatiblePresets[kind].priceQualifier;

    it('is carried by the web model notes and price note exactly when the server sets one', () => {
      const web = webProvider(kind);
      if (qualifier) {
        for (const model of web.models) {
          expect(model.note ?? '', `Preset drift: provider ${kind}, model ${model.id}, field note should mention "${qualifier}"`).toContain(qualifier);
        }
        expect(web.priceNote ?? '', `Preset drift: provider ${kind}, field priceNote should mention "${qualifier}"`).toContain(qualifier);
      } else {
        for (const model of web.models) {
          expect(model.note, `Preset drift: provider ${kind}, model ${model.id}, field note should be empty because the server sets no price qualifier`).toBeUndefined();
        }
        expect(web.priceNote, `Preset drift: provider ${kind}, field priceNote should be empty because the server sets no price qualifier`).toBeUndefined();
      }
    });
  });

  // Fields that exist on one side only, skipped on purpose:
  // - Price dates: the server dates its list prices (`providerPricesAsOf`) and puts the date in the price hint it sends.
  //   The web app keeps no date, it only shows the server's hint, so there is nothing to compare. The check below only
  //   proves the date is a real day, so a malformed date cannot reach the screen.
  // - Cached input prices, JSON mode, strict tools, key check, quirks, base URLs: server only, the web never shows them.
  // - Model display names: the server has provider labels but no per model display name, so web `name` is checked
  //   against the provider label above and, for models, only that it is not blank.
  // - Web only: `introduction`, `destination`, and the Haiku "up to 100K prompts" note are interface copy.
  it('has a server price date that is a real day', () => {
    expect(providerPricesAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(providerPricesAsOf)), 'Server providerPricesAsOf is not a real date').toBe(false);
  });

  it('gives every web model a display name', () => {
    for (const provider of PROVIDERS) {
      for (const model of provider.models) {
        expect(model.name.trim(), `Preset drift: provider ${provider.kind}, model ${model.id}, field name is blank`).not.toBe('');
      }
    }
  });

  it('keeps the server price hint consistent with the web prices', () => {
    // The hint is what clients see from the server, so it has to carry the same numbers the web shows.
    for (const entry of providerCatalog()) {
      const web = webProvider(entry.kind);
      for (const model of entry.models) {
        const webModel = web.models.find((item) => item.id === model.id);
        expect(webModel, `Preset drift: provider ${entry.kind}, model ${model.id}, missing on the web`).toBeDefined();
        const money = (value: number) => `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
        expect(model.priceHint, `Preset drift: provider ${entry.kind}, model ${model.id}, server hint does not carry the web input price`).toContain(`${money(webModel!.inputPerMillion)} in`);
        expect(model.priceHint, `Preset drift: provider ${entry.kind}, model ${model.id}, server hint does not carry the web output price`).toContain(`${money(webModel!.outputPerMillion)} out`);
      }
    }
  });
});
