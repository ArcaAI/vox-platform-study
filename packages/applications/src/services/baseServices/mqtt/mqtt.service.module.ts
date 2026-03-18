import { Module } from '@nestjs/common';
import { MqttService } from './mqtt.service';
import { IMqttService } from './IMqttService';

@Module({
    providers: [
        {
            provide: IMqttService,
            useClass: MqttService,
        },
    ],
    exports: [MqttService],
})
export class MqttServiceModule {}
