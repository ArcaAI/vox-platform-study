/**
 * A parseable WAV fixture for `transcribeFile` tests.
 *
 * Since the upload route measures duration from the container header
 * and FAILS CLOSED when it cannot read one. A placeholder like
 * `Buffer.from('audio')` therefore no longer reaches the handler logic under
 * test — it is rejected as "could not determine the duration" first. Tests that
 * are about pipeline resolution, tenant resolution or dispatch must hand the
 * route a file whose header actually declares a length.
 *
 * The payload is elided: `size` reports what the file WOULD weigh, while
 * `buffer` carries the 44-byte header alone, so a 60-minute fixture costs 44
 * bytes instead of 115 MB. The duration probe reads the header, and the size
 * check reads `file.size` — neither touches the samples.
 */
export function wavFixture(seconds: number, overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  const sampleRate = 16000;
  const byteRate = sampleRate * 2; // mono, 16-bit
  const dataSize = Math.round(seconds * byteRate);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return {
    buffer: header,
    size: 44 + dataSize,
    mimetype: 'audio/wav',
    originalname: 'visit.wav',
    ...overrides,
  } as Express.Multer.File;
}
