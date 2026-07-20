import path from 'path';
import { checkDirectory } from './checkDirectory';

/**
 * Prisma DMMF Document type
 */
export interface DMMF {
  datamodel: {
    models: any[];
    enums: any[];
    types: any[];
  };
  schema: {
    inputObjectTypes: any;
    outputObjectTypes: any;
    enumTypes: any;
    rootQueryType?: string;
    rootMutationType?: string;
  };
  mappings: {
    modelOperations: any[];
    otherOperations: {
      read: string[];
      write: string[];
    };
  };
}

/**
 * Gets the Prisma DMMF (Data Model Meta Format) from a generated prisma client directory
 * @param prismaClientPath Path to the generated prisma client directory
 * @returns The Prisma DMMF document
 * @throws Error if the prisma client cannot be found or loaded
 */
export async function getPrismaDMMF(prismaClientPath: string): Promise<DMMF> {
  // Verify the prisma client directory exists
  if (!checkDirectory(prismaClientPath)) {
    throw new Error(`Prisma client directory not found at path: ${prismaClientPath}`);
  }

  try {
    // Resolve the path to handle both relative and absolute paths
    const resolvedPath = path.isAbsolute(prismaClientPath)
      ? prismaClientPath
      : path.resolve(process.cwd(), prismaClientPath);

    // Dynamically import the prisma client
    const prismaClient = (await import(resolvedPath));

    if (!prismaClient.Prisma || !prismaClient.Prisma.dmmf) {
      throw new Error('Invalid Prisma client or DMMF not found');
    }

    return prismaClient.Prisma.dmmf as DMMF;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load Prisma DMMF: ${error.message}`);
    } else {
      throw new Error('Failed to load Prisma DMMF due to an unknown error');
    }
  }
}

export default getPrismaDMMF;