import { describe, it, expect } from 'vitest';

// Static import: a dynamic `import()` of an extensionless relative specifier is
// an ECMAScript import, which `moduleResolution: nodenext` rejects without an
// explicit file extension.
import * as mapModule from '../../../registries/mapcn/map';

describe('Mapcn', () => {
  it('exports Map component', () => {
    expect(mapModule.Map).toBeDefined();
  });
});
