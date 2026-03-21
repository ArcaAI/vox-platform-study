export interface IPrismaStudioService {
    executeQuery(query: unknown): Promise<unknown[]>;
    executeSequence(sequence: readonly [unknown, unknown]): Promise<unknown[]>;
}

export const IPrismaStudioService = Symbol('IPrismaStudioService');
