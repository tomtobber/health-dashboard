import { Request, Response, NextFunction } from 'express';
export declare const authRouter: import("express-serve-static-core").Router;
export interface AuthenticatedRequest extends Request {
    user?: {
        id: string;
        email: string;
    };
}
export declare function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction): void;
