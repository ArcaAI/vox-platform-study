import * as jwt from 'jsonwebtoken'; // Importing the jsonwebtoken library for creating JSON Web Tokens
import { UserSession } from './dto'; // Importing the UserSession interface from the dto module

type Unit =
  | 'Years'
  | 'Year'
  | 'Yrs'
  | 'Yr'
  | 'Y'
  | 'Weeks'
  | 'Week'
  | 'W'
  | 'Days'
  | 'Day'
  | 'D'
  | 'Hours'
  | 'Hour'
  | 'Hrs'
  | 'Hr'
  | 'H'
  | 'Minutes'
  | 'Minute'
  | 'Mins'
  | 'Min'
  | 'M'
  | 'Seconds'
  | 'Second'
  | 'Secs'
  | 'Sec'
  | 's'
  | 'Milliseconds'
  | 'Millisecond'
  | 'Msecs'
  | 'Msec'
  | 'Ms';

type UnitAnyCase = Unit | Uppercase<Unit> | Lowercase<Unit>;

export type StringValue = `${number}` | `${number}${UnitAnyCase}` | `${number} ${UnitAnyCase}`;

/**
 * Interface representing the properties required to create a JWT (JSON Web Token).
 * This interface extends the UserSession interface to include additional properties
 * necessary for token creation.
 */
export interface CreateJwtProps extends UserSession {
  jwtSecretKey: string; // The secret key used to sign the JWT, ensuring its integrity and authenticity.
  expiresIn: StringValue; // The duration for which the token is valid, specified in a format accepted by jsonwebtoken (e.g., '1h', '2d').
}

/**
 * Creates a JSON Web Token (JWT) using the provided payload.
 *
 * @param payload - An object containing the properties required to create the JWT.
 *                  This object must include all properties from CreateJwtProps except for 'token'.
 * @returns A string representing the signed JWT.
 *
 * The function extracts the jwtSecretKey and expiresIn from the payload,
 * and uses the jsonwebtoken library to sign the token with the provided secret key
 * and expiration time.
 */
export function createJwt(payload: Omit<CreateJwtProps, 'token'>): string {
  const { jwtSecretKey, expiresIn, ...restPayload } = payload; // Destructuring the payload to extract the secret key and expiration time

  return jwt.sign(
    {
      ...restPayload, // Including the rest of the payload in the token
    },
    jwtSecretKey, // Signing the token with the provided secret key
    { expiresIn }, // Setting the expiration time for the token
  );
}
