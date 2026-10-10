import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateModelRequest } from '../dto/create-model.request';
import { UpdateModelRequest } from '../dto/update-model.request';

// TASK-1059: seeded rows carry version numbers in their slug (`granite-guardian-4.1-8b`); the
// request rules and the entity must agree, or such a row can never be created or edited.
const slugErrors = async (cls: new () => object, slug: string) =>
  (await validate(plainToInstance(cls, { slug }) as object)).filter((e) => e.property === 'slug');

describe('model slug accepts a dot between segments', () => {
  for (const cls of [CreateModelRequest, UpdateModelRequest]) {
    it(`${cls.name} accepts granite-guardian-4.1-8b`, async () => {
      expect(await slugErrors(cls, 'granite-guardian-4.1-8b')).toHaveLength(0);
    });
    it(`${cls.name} rejects a dangling or doubled dot`, async () => {
      for (const slug of ['granite.', '.granite', 'granite..8b']) {
        expect(await slugErrors(cls, slug)).not.toHaveLength(0);
      }
    });
  }
});
