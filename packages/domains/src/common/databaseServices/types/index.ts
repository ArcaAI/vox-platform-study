import { CorePrisma, CorePrismaClient } from '../core';

export type CoreModelNames = CorePrisma.ModelName;

export type ModelNames = CoreModelNames;

export type PrismaClients = any;

/**
 * A general client type that extends all Prisma clients
 * This allows accessing any model from any of the generated Prisma clients
 */
export type GeneralPrismaClient = {
    [K in keyof CorePrismaClient]: CorePrismaClient[K];
};
