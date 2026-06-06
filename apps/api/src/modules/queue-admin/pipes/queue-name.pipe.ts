import { Injectable, NotFoundException, PipeTransform } from '@nestjs/common';
import { JobQueue } from '@arcaai/domains';

/**
 * Validates a `:queueName` route param against the registered {@link JobQueue}
 * enum. Without this, an unknown queue would reach
 * `ModuleRef.get(getQueueToken(name))` and surface as an opaque provider
 * resolution 500; instead callers get a clean 404.
 */
@Injectable()
export class QueueNamePipe implements PipeTransform<string, string> {
  private static readonly KNOWN = new Set<string>(Object.values(JobQueue));

  transform(value: string): string {
    if (!QueueNamePipe.KNOWN.has(value)) {
      throw new NotFoundException(`Queue '${value}' is not registered`);
    }
    return value;
  }
}
