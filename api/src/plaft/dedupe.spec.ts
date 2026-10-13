import { matchKey, selectNewMatches } from './dedupe';

describe('selectNewMatches', () => {
  const m = (source: string, entry_id: string, score = 0.9) => ({ source, entry_id, score });

  it('descarta las ya vistas y deduplica dentro del lote', () => {
    const existing = [matchKey(m('ofac_sdn', '1'))];
    const out = selectNewMatches(existing, [m('ofac_sdn', '1'), m('un', '1'), m('ofac_sdn', '2', 0.86), m('ofac_sdn', '2', 0.95)]);
    expect(out).toEqual([m('un', '1'), m('ofac_sdn', '2', 0.95)]);
  });

  it('la misma entrada en otra fuente es nueva', () => {
    expect(selectNewMatches([matchKey(m('un', '7'))], [m('pep_pe', '7')])).toHaveLength(1);
  });

  it('sin coincidencias no hay nada nuevo', () => {
    expect(selectNewMatches([], [])).toEqual([]);
  });
});
