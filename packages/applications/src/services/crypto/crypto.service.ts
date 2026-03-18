import { Injectable, OnModuleInit, Logger, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { EventTypes } from '@arcaai/domains';
import { ICryptoService } from './ICryptoService';
import { IAppSettingsService } from '../baseServices/_meta/appSettings';

@Injectable()
export class CryptoService implements ICryptoService, OnModuleInit {
    private readonly logger = new Logger(CryptoService.name);
    private readonly DEFAULT_SALT_ROUNDS = 10;
    private readonly DEFAULT_ALGORITHM = 'aes-256-cbc';
    private readonly DEFAULT_IV_LENGTH = 16;

    private saltRounds: number = this.DEFAULT_SALT_ROUNDS;
    private algorithm: string = this.DEFAULT_ALGORITHM;
    private ivLength: number = this.DEFAULT_IV_LENGTH;

    constructor(@Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService) {}

    async onModuleInit() {
        await this.loadSettings();
    }

    @OnEvent(EventTypes.AppSettingsUpdated)
    private async handleSettingsUpdate() {
        this.logger.log('Reloading crypto settings due to AppSettings update');
        await this.loadSettings();
    }

    private async loadSettings() {
        this.saltRounds = this.appSettings.getValueWithDefault('crypto.saltRounds', this.DEFAULT_SALT_ROUNDS);
        this.algorithm = this.appSettings.getValueWithDefault('crypto.algorithm', this.DEFAULT_ALGORITHM);
        this.ivLength = this.appSettings.getValueWithDefault('crypto.ivLength', this.DEFAULT_IV_LENGTH);

        this.logger.debug('Crypto settings loaded', {
            saltRounds: this.saltRounds,
            algorithm: this.algorithm,
            ivLength: this.ivLength
        });
    }

    async hash(password: string): Promise<string> {
        return bcrypt.hash(password, this.saltRounds);
    }

    async verify(password: string, hash: string): Promise<boolean> {
        return bcrypt.compare(password, hash);
    }

    async encrypt(data: string, key: string): Promise<string> {
        const iv = crypto.randomBytes(this.ivLength);
        const cipher = crypto.createCipheriv(
            this.algorithm,
            Buffer.from(key),
            iv
        );

        let encrypted = cipher.update(data);
        encrypted = Buffer.concat([encrypted, cipher.final()]);

        return iv.toString('hex') + ':' + encrypted.toString('hex');
    }

    async decrypt(encryptedData: string, key: string): Promise<string> {
        const [ivHex, encryptedHex] = encryptedData.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const encrypted = Buffer.from(encryptedHex, 'hex');

        const decipher = crypto.createDecipheriv(
            this.algorithm,
            Buffer.from(key),
            iv
        );

        let decrypted = decipher.update(encrypted);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return decrypted.toString();
    }
}
