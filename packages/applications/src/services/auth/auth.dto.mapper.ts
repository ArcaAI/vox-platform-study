import { AutoClassMapper, UserEntity } from '@arcaai/domains';
import { OAuthUserResponse, CheckAuthResponse, UserSession } from './dto';

export class AuthDtoMapper {
    static ToResponse(entity: UserEntity): OAuthUserResponse {
        return AutoClassMapper(entity, OAuthUserResponse, {
            // emailAddress: (obj: UserEntity) => {
            //     return obj.emailAddress
            //         ? {
            //               id: obj.emailAddress.id,
            //               value: obj.emailAddress.fullAddress,
            //           }
            //         : null;
            // },
            // phoneNumber: (obj: UserEntity) => {
            //     return obj.phoneNumber
            //         ? {
            //               id: obj.phoneNumber.id,
            //               value: obj.phoneNumber.number,
            //           }
            //         : null;
            // },
        });
    }

    static ToCheckAuthResponse(userSession: UserSession): CheckAuthResponse {
        return AutoClassMapper(userSession, CheckAuthResponse);
    }
}
