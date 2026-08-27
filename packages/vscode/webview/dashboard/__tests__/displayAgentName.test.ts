// Agent Manager S6e — honest agent labels. displayAgentName used to collapse
// ANY unknown agent id through a one-entry roster to the brand default 'Tsuru',
// so a board run's own agent id exported/titled as 'Tsuru'. It now resolves known
// roster ids to their brand label but renders an UNKNOWN id as ITSELF
// (capitalised), so an unharvested id shows as itself and a typed agent shows its real id.

import { describe, it, expect } from 'vitest';
import { displayAgentName } from '../../../src/workspace/WorkspaceReader';

describe('displayAgentName (honest labels)', () => {
  it('renders an unknown id as ITSELF, capitalised — not collapsed to Tsuru', () => {
    expect(displayAgentName('wombat')).toBe('Wombat');
    expect(displayAgentName('plan')).toBe('Plan');
    expect(displayAgentName('WOMBAT')).toBe('Wombat'); // case-insensitive, still capitalised
  });

  it('still resolves the known roster ids/archetypes to the brand label', () => {
    expect(displayAgentName('tsuru')).toBe('Tsuru');
    expect(displayAgentName('coder')).toBe('Tsuru'); // internal archetype -> brand label
  });

  it('falls back to the brand default only for empty / unset input', () => {
    expect(displayAgentName('')).toBe('Tsuru');
    expect(displayAgentName('   ')).toBe('Tsuru');
    expect(displayAgentName(undefined)).toBe('Tsuru');
  });
});
