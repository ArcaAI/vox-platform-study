/**
 * RuleTester pins for `no-controller-direct-prisma`.
 *
 * Coverage:
 * - bare `this.databaseService.client.foo.bar(...)` → ERROR
 * - aliased `const prisma = this.databaseService.client; prisma.foo` → ERROR
 * (the alias itself is the offending access; downstream calls are NOT
 * re-flagged because the rule fires only on the `.client` step)
 * - escape hatch via `/** @allowedDirectPrisma <reason> *\/` on the
 * immediately-preceding line → CLEAN
 * - escape hatch on the enclosing statement → CLEAN
 * - benign chain (no `databaseService`) → CLEAN
 * - service-layer-style access NOT wrapped in `this.databaseService`
 * (e.g. `prisma.foo.bar` where prisma is a free identifier) → CLEAN
 * (covered by service-layer Prisma access which the rule does NOT
 * restrict — controllers are the scoped target)
*/
'use strict';

// Pin to the workspace ESLint that `@arcaai/config-eslint` resolves (the
// same major the flat presets run under). The rule itself is config-format
// agnostic; the test just needs the flat-config RuleTester.
const { RuleTester } = require('@arcaai/config-eslint/node_modules/eslint');
const rule = require('../rules/no-controller-direct-prisma');

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('no-controller-direct-prisma', rule, {
  valid: [
    {
      name: 'a chain that does not start at `databaseService` is allowed',
      code: 'class Foo { bar() { return this.repo.findAll(); } }',
    },
    {
      name: 'a free-standing `prisma.foo.bar` (no databaseService receiver) is allowed',
      code: 'function fn(prisma) { return prisma.user.findMany(); }',
    },
    {
      name: 'escape hatch on the preceding line is honored',
      code: `
        class Foo {
          bar() {
            /** @allowedDirectPrisma documented justification */
            return this.databaseService.client.user.findMany();
          }
        }
      `,
    },
    {
      name: 'escape hatch on the enclosing method is honored',
      code: `
        class Foo {
          /** @allowedDirectPrisma documented justification */
          bar() {
            return this.databaseService.client.user.findMany();
          }
        }
      `,
    },
    {
      name: 'escape hatch with multi-word justification is honored',
      code: `
        class Foo {
          bar() {
            /** @allowedDirectPrisma legitimate platform-admin bypass for cron */
            return this.databaseService.client.user.findMany();
          }
        }
      `,
    },
  ],

  invalid: [
    {
      name: 'bare direct-Prisma chain is flagged',
      code: `
        class Foo {
          bar() {
            return this.databaseService.client.user.findMany();
          }
        }
      `,
      errors: [{ messageId: 'directPrismaInController' }],
    },
    {
      name: 'alias assignment is flagged (the `.client` step is the offender)',
      code: `
        class Foo {
          bar() {
            const prisma = this.databaseService.client;
            return prisma.user.findMany();
          }
        }
      `,
      errors: [{ messageId: 'directPrismaInController' }],
    },
    {
      name: 'a comment without the @allowedDirectPrisma directive is NOT an escape hatch',
      code: `
        class Foo {
          bar() {
            /** Some unrelated comment */
            return this.databaseService.client.user.findMany();
          }
        }
      `,
      errors: [{ messageId: 'directPrismaInController' }],
    },
    {
      name: 'an @allowedDirectPrisma comment that is too far away (>3 lines) does not silence the rule',
      code: `
        class Foo {
          /** @allowedDirectPrisma justification */
          bar() {
            const a = 1;
            const b = 2;
            const c = 3;
            const d = 4;
            const e = 5;
            return this.databaseService.client.user.findMany();
          }
        }
      `,
      errors: [{ messageId: 'directPrismaInController' }],
    },
  ],
});

console.log('no-controller-direct-prisma: RuleTester passes (W6.4)');
