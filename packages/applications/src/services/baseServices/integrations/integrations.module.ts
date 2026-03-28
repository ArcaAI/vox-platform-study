import { Module } from '@nestjs/common';

// TODO: Implement this

const integrations: never[] = [];

@Module({
  providers: [...integrations],
  exports: [...integrations],
})
export class IntegrationsModule {}
