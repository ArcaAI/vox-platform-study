/**
 * RuleTester pins for `no-silent-catch`.
 *
 * Flags `.catch(() => null | [] | undefined | {})` and empty `catch {}` blocks;
 * a deliberate swallow carries `// swallow-ok: <reason>` (reason required).
 */
'use strict';

const { RuleTester } = require('@arcaai/config-eslint/node_modules/eslint');
const rule = require('../rules/no-silent-catch');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

const handler = [{ messageId: 'silentCatchHandler' }];
const block = [{ messageId: 'silentCatchBlock' }];

ruleTester.run('no-silent-catch', rule, {
  valid: [
    {
      name: 'a handler that inspects the error is fine',
      code: `repo.findById(id).catch((error) => { if (!isNotFound(error)) throw error; return null; });`,
    },
    {
      name: 'a handler that computes a real fallback is fine',
      code: `repo.findAll().catch(() => previous.policies ?? []);`,
    },
    {
      name: 'a catch block that logs is fine',
      code: `try { work(); } catch (error) { logger.warn({ error }); }`,
    },
    {
      name: 'a non-catch method taking an arrow returning null is fine',
      code: `promise.then(() => null);`,
    },
    {
      name: 'swallow-ok with a reason on the line above the .catch',
      code: `
        // swallow-ok: eviction is best-effort, the TTL is the backstop
        await cache.evict(key).catch(() => undefined);
      `,
    },
    {
      name: 'swallow-ok with a reason on the same line',
      code: `await cache.evict(key).catch(() => undefined); // swallow-ok: TTL is the backstop`,
    },
    {
      name: 'swallow-ok on the .catch line of a multi-line chain',
      code: `
        await repo
          .findById(id)
          .catch(() => null); // swallow-ok: optional decoration
      `,
    },
    {
      name: 'swallow-ok inside an empty catch block',
      code: `
        try {
          res.setHeader('Retry-After', '1');
        } catch {
          // swallow-ok: a committed response cannot take a late header
        }
      `,
    },
  ],
  invalid: [
    { name: '.catch(() => null)', code: `repo.findById(id).catch(() => null);`, errors: handler },
    { name: '.catch(() => [])', code: `repo.findAll().catch(() => []);`, errors: handler },
    { name: '.catch(() => undefined)', code: `cache.evict(key).catch(() => undefined);`, errors: handler },
    { name: '.catch(() => {})', code: `cache.evict(key).catch(() => {});`, errors: handler },
    { name: '.catch(() => ({}))', code: `repo.read().catch(() => ({}));`, errors: handler },
    { name: 'a parameter does not make it inspect the error', code: `repo.findById(id).catch((_e) => null);`, errors: handler },
    { name: 'function expression returning null', code: `repo.findById(id).catch(function () { return null; });`, errors: handler },
    { name: 'empty catch block', code: `try { work(); } catch {}`, errors: block },
    { name: 'empty catch block with a bound error', code: `try { work(); } catch (e) {}`, errors: block },
    {
      name: 'a comment without the marker does not excuse it',
      code: `
        try {
          work();
        } catch {
          // not fatal
        }
      `,
      errors: block,
    },
    {
      name: 'swallow-ok without a reason does not excuse it',
      code: `repo.findById(id).catch(() => null); // swallow-ok:`,
      errors: handler,
    },
  ],
});

console.log('no-silent-catch: RuleTester passes');
