import { describe, it, expect } from 'vitest';

// Static import: a dynamic `import()` of an extensionless relative specifier is
// an ECMAScript import, which `moduleResolution: nodenext` rejects without an
// explicit file extension.
import * as qrCodeModule from '../../../registries/kibo-ui/qr-code/index';

describe('QRCode', () => {
  it('exports QRCode component', () => {
    expect(qrCodeModule.QRCode).toBeDefined();
  });
});
