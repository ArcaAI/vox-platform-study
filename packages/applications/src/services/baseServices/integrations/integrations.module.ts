import { Module } from '@nestjs/common';

const integrations: never[] = [];

@Module({
  providers: [...integrations],
  exports: [...integrations],
})
export class IntegrationsModule {}
