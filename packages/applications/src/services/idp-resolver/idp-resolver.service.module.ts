import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { IdpResolverService } from './idp-resolver.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [IdpResolverService],
  exports: [IdpResolverService],
})
export class IdpResolverServiceModule {}
