import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { INotificationService } from './INotificationService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';

// TODO: Implement this

@Module({
    imports: [CommonServiceModule, CoreDatabaseModule],
    providers: [
        {
            provide: INotificationService,
            useClass: NotificationService
        }
    ],
    exports: [INotificationService]
})
export class NotificationServiceModule {}
