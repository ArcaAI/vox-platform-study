import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CryptoService } from './crypto.service';
import { ICryptoService } from './ICryptoService';
import { AppSettingsModule } from '../baseServices/_meta/appSettings/appSettings.module';

@Module({
    imports: [
        AppSettingsModule,
        EventEmitterModule
    ],
    providers: [
        {
            provide: ICryptoService,
            useClass: CryptoService
        }
    ],
    exports: [ICryptoService]
})
export class CryptoServiceModule {}
