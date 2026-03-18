import { Injectable } from '@nestjs/common';
import { PassportSerializer } from '@nestjs/passport';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SessionSerializerCallback = (err: any, id?: any) => void;

@Injectable()
export class SessionSerializer extends PassportSerializer {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    serializeUser(user: any, done: SessionSerializerCallback) {
        done(null, user.id);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deserializeUser(user: any, done: SessionSerializerCallback) {
        done(null, user);
    }
}
