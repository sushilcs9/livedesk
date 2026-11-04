// Adapter registry. To add a provider: write create<Name>Adapter(sourceConfig) returning
// { id, describe(), fetch() -> { contests: CanonicalContest[], meta } , detail?(contest) }
// and register it here. Sources are then configured per event, with no core changes.
import { createCivicApiAdapter } from './civicapi.js';
import { createSampleAdapter } from './sample.js';
import { createApAdapter, createClarityAdapter, createJsonFeedAdapter } from './others.js';

export const ADAPTERS = {
  civicapi: createCivicApiAdapter,
  sample: createSampleAdapter,
  ap: createApAdapter,
  clarity: createClarityAdapter,
  jsonfeed: createJsonFeedAdapter,
};

export function createAdapter(source, opts) {
  const f = ADAPTERS[source.adapter];
  if (!f) throw new Error(`Unknown adapter "${source.adapter}"`);
  return f(source, opts);
}
