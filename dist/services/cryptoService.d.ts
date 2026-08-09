export declare function encryptToken(plainText: string): string;
export declare function decryptToken(encryptedJson: string): string;
export declare function signState(payload: Record<string, unknown>): string;
export declare function verifyState<T = Record<string, unknown>>(signedStateToken: string): T;
